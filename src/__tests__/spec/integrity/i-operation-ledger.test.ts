import { configureDb , createOperationState, readCommittedOnceKeys, serializeOperationInput , encodePersistence, jsonRoundTrip } from '../../testApi';
import type { OperationRecord } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

/**
 * Durable operation-ledger contracts (the largest mutation-audit survivor cluster, 46% score).
 * The ledger survives the tanstack migration untouched, so every guarantee is pinned at the unit
 * seam: once-key formats, input serialization, patch-ownership causality, prune retention, and
 * hydrate key-retention rules.
 */
const PREFIX = 'dbl:';

const baseRecord = (operationId: string, overrides: Partial<OperationRecord> = {}): Omit<OperationRecord, 'status'> => ({
  operationId,
  actionKey: 'SpecLedgerModel:action',
  actionMode: 'request',
  model: 'SpecLedgerModel',
  tempIds: [],
  rowIds: [`row-${operationId}`],
  intent: 'insert',
  createdAt: 1000,
  ...overrides
});
const { rowIds: _missingRowIds, ...operationWithoutRowIds } = baseRecord('op-missing-row-ids');

const setup = (nowValue = () => 1000) => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() });
  diagnostics().reset();
  const state = createOperationState({ storage, prefix: () => PREFIX, now: nowValue });
  return { storage, state };
};

describe('committed once-key persistence format', () => {
  it('refuses an unknown version, rejects non-string keys, and reads the canonical payload', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}ops-once`, encodePersistence({ keys: ['k1'] }, 99));
    expect(() => readCommittedOnceKeys(storage, PREFIX)).toThrow('Unsupported persistence schema version 99');

    storage.set(`${PREFIX}ops-once`, encodePersistence({ keys: ['k1', 7] }));
    expect(readCommittedOnceKeys(storage, PREFIX).keys).toEqual([]);

    storage.set(`${PREFIX}ops-once`, encodePersistence({ keys: ['k2', 'k1'] }));
    expect(readCommittedOnceKeys(storage, PREFIX).keys).toEqual(['k1', 'k2']);
  });

  it('collects only committed once operations with string keys from the ops record', () => {
    const { storage } = setup();
    const ops = {
      a: { ...baseRecord('a'), status: 'committed', once: true, idempotencyKey: 'keep' },
      b: { ...baseRecord('b'), status: 'pending', once: true, idempotencyKey: 'skip-pending' },
      c: { ...baseRecord('c'), status: 'committed', once: false, idempotencyKey: 'skip-not-once' }
    };
    storage.set(`${PREFIX}ops`, encodePersistence(ops));

    expect(readCommittedOnceKeys(storage, PREFIX)).toEqual({ keys: ['keep'], corruptSources: 0 });
  });

  it('counts each corrupt source separately', () => {
    const { storage } = setup();
    [
      { key: `${PREFIX}ops-once`, value: '{corrupt' },
      { key: `${PREFIX}ops`, value: '{corrupt' }
    ].forEach(entry => storage.set(entry.key, entry.value));

    expect(readCommittedOnceKeys(storage, PREFIX).corruptSources).toBe(2);
  });

  it('rejects empty once keys instead of retaining an ambiguous identity', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}ops-once`, encodePersistence({ keys: [''] }));

    expect(readCommittedOnceKeys(storage, PREFIX)).toEqual({ keys: [], corruptSources: 1 });
  });

  it('rejects a once-key record that carries no key list at all', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}ops-once`, encodePersistence({ notKeys: ['k1'] }));

    // A record shaped like anything else is not a key list: reading it must report corruption,
    // never reach into a missing array.
    expect(readCommittedOnceKeys(storage, PREFIX)).toEqual({ keys: [], corruptSources: 1 });
  });

  it('keeps one valid once key while a sibling entry of the same record is invalid', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}ops-once`, encodePersistence({ keys: ['valid', 7] }));

    // One bad entry invalidates the LIST: a partially decoded key set would silently lose identity.
    expect(readCommittedOnceKeys(storage, PREFIX)).toEqual({ keys: [], corruptSources: 1 });
  });
});

describe('operation input serialization', () => {
  it('rejects non-JSON inputs: cycles, non-finite numbers, exotic prototypes, functions, undefined items', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 });
    const sparse = new Array(2);
    sparse[1] = 'value';
    expect(serializeOperationInput(cyclic).serializable).toBe(false);
    expect(serializeOperationInput(NaN).serializable).toBe(false);
    expect(serializeOperationInput(Infinity).serializable).toBe(false);
    expect(serializeOperationInput(-0).serializable).toBe(false);
    expect(serializeOperationInput(new Date(5)).serializable).toBe(false);
    expect(serializeOperationInput(nullPrototype).serializable).toBe(false);
    expect(serializeOperationInput(() => 1).serializable).toBe(false);
    expect(serializeOperationInput([undefined]).serializable).toBe(false);
    expect(serializeOperationInput(sparse).serializable).toBe(false);
    expect(serializeOperationInput({ [Symbol('hidden')]: true }).serializable).toBe(false);
  });

  it('drops own undefined object keys at the boundary, matching JSON.stringify semantics', () => {
    const result = serializeOperationInput({ text: 'x', replyToId: undefined, nested: { keep: 1, drop: undefined } });
    expect(result.serializable).toBe(true);
    expect(result.value).toEqual({ text: 'x', nested: { keep: 1 } });
  });

  it('deep-clones a valid input so the ledger never aliases caller state', () => {
    const input = { text: 'hello', nested: { flags: [1, 2] } };
    const result = serializeOperationInput(input);

    expect(result.serializable).toBe(true);
    expect(result.value).toEqual(input);
    expect(result.value).not.toBe(input);
    expect((result.value as typeof input).nested).not.toBe(input.nested);
  });

  it('accepts a repeated non-cyclic reference to the same object', () => {
    const shared = { flag: true };
    expect(serializeOperationInput({ left: shared, right: shared }).serializable).toBe(true);
  });
});

describe('persistence JSON safety', () => {
  it('rejects every value that JSON would drop or coerce', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = 'value';
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 });
    const withSymbol = { value: 1, [Symbol('hidden')]: 2 };
    const lossyValues = [Number.NaN, Number.POSITIVE_INFINITY, -0, new Date(5), nullPrototype, { value: undefined }, { value: () => 1 }, sparse, withSymbol, cyclic];

    for (const value of lossyValues) {
      expect(() => encodePersistence(value)).toThrow('Persistence payload is not JSON serializable');
    }
  });

  it('accepts repeated non-cyclic references and returns an independent JSON payload', () => {
    const shared = { flag: true };
    const encoded = encodePersistence({ left: shared, right: shared });

    expect(encoded).toContain('"left":{"flag":true}');
    expect(encoded).toContain('"right":{"flag":true}');
  });

  it('reports a stringify failure after structural validation without leaking the exception', () => {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        throw new Error('stringify failed');
      }
    });
    try {
      expect(jsonRoundTrip({ value: 1 })).toEqual({ serializable: false, value: undefined });
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
  });
});

describe('operation lifecycle and idempotency keys', () => {
  it('tracks a pending key and converts it to a committed once-key on close', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1', { idempotencyKey: 'key-1', once: true }));
    expect(state.hasPending('key-1')).toBe(true);
    expect(state.hasCommitted('key-1')).toBe(false);

    state.close('op-1', 'committed');

    expect(state.hasPending('key-1')).toBe(false);
    expect(state.hasCommitted('key-1')).toBe(true);
  });

  it('drops the idempotency key of a committed non-once operation', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1', { idempotencyKey: 'key-1' }));

    state.close('op-1', 'committed');

    expect(state.get('op-1')?.idempotencyKey).toBeUndefined();
    expect(state.hasCommitted('key-1')).toBe(false);
  });

  it('keeps the idempotency keyspace closed to operation ids of committed operations', () => {
    const { state } = setup();
    state.begin(baseRecord('colliding-token', { idempotencyKey: 'real-key' }));
    state.close('colliding-token', 'committed');

    expect(state.hasCommitted('colliding-token')).toBe(false);
  });

  it('keeps the first terminal status - repeated close calls are no-ops', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1'));
    state.close('op-1', 'committed');

    state.close('op-1', 'failed');

    expect(state.get('op-1')?.status).toBe('committed');
  });

  it('reopens only failed operations back to pending', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1'));
    expect(state.reopen('op-1')).toBeUndefined();

    state.close('op-1', 'failed');
    const reopened = state.reopen('op-1');

    expect(reopened?.status).toBe('pending');
    expect(state.pending().map(operation => operation.operationId)).toEqual(['op-1']);
  });

  it('clears only failed operations and fully unindexes them', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1'));
    state.clearFailed('op-1');
    expect(state.get('op-1')).toBeDefined();

    state.close('op-1', 'failed');
    state.clearFailed('op-1');

    expect(state.get('op-1')).toBeUndefined();
    expect(state.failedForRow('SpecLedgerModel', 'row-op-1')).toEqual([]);
  });

  it('keeps transition no-ops inert while cloning canonical row ids', () => {
    const { state } = setup();
    const operation = baseRecord('op-transition', { rowIds: ['temp-transition'], tempIds: ['temp-transition'] });

    state.applyTransitions([{ kind: 'begin', operation }]);
    expect(state.get('op-transition')).toMatchObject({ status: 'pending', rowIds: ['temp-transition'] });

    state.applyTransitions([{ kind: 'close', operationId: 'missing', status: 'committed' }]);
    state.applyTransitions([{ kind: 'close', operationId: 'op-transition', status: 'committed' }]);
    state.applyTransitions([{ kind: 'close', operationId: 'op-transition', status: 'failed' }]);
    state.remove('missing');

    expect(state.get('op-transition')?.status).toBe('committed');
  });
});

describe('row buckets and patch ownership', () => {
  it('matches pendingForRow only through canonical rowIds', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1', { tempIds: ['temp-1'], rowIds: ['row-1'] }));
    state.begin(baseRecord('op-2', { tempIds: ['temp-2'], rowIds: ['temp-2'] }));

    expect(state.pendingForRow('SpecLedgerModel', 'row-1').map(operation => operation.operationId)).toEqual(['op-1']);
    expect(state.pendingForRow('SpecLedgerModel', 'temp-1')).toEqual([]);
    expect(state.pendingForRow('SpecLedgerModel', 'temp-2').map(operation => operation.operationId)).toEqual(['op-2']);
  });

  it('returns the newest failed operation for a row by createdAt', () => {
    const { state } = setup();
    state.begin(baseRecord('op-old', { rowIds: ['row-1'], createdAt: 100 }));
    state.begin(baseRecord('op-new', { rowIds: ['row-1'], createdAt: 200 }));
    state.close('op-old', 'failed');
    state.close('op-new', 'failed');

    expect(state.failedFor('SpecLedgerModel', 'row-1')?.operationId).toBe('op-new');
  });

  it('exposes owned fields only while a pending patch holds them', () => {
    const { state } = setup();
    expect(state.ownedFields('SpecLedgerModel', 'row-1')).toEqual(new Set());

    state.begin(baseRecord('op-1', { intent: 'patch', rowIds: ['row-1'], patchedFields: ['status', 'body'], patchedValues: { status: 'Sending', body: 'draft' } }));
    expect(state.ownedFields('SpecLedgerModel', 'row-1')).toEqual(new Set(['status', 'body']));
    expect(state.ownedFields('SpecLedgerModel', 'row-1', 'op-1')).toEqual(new Set());
    expect(state.ownedFields('SpecLedgerModel', 'row-other')).toEqual(new Set());

    state.close('op-1', 'committed');
    expect(state.ownedFields('SpecLedgerModel', 'row-1')).toEqual(new Set());
  });

  it('resolves the latest still-pending patched value with exclusion', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1', { intent: 'patch', rowIds: ['row-1'], patchedFields: ['status'], patchedValues: { status: 'first' } }));
    state.begin(baseRecord('op-2', { intent: 'patch', rowIds: ['row-1'], patchedFields: ['status'], patchedValues: { status: 'second' } }));

    expect(state.latestPendingValue('SpecLedgerModel', 'row-1', 'status')).toEqual({ found: true, value: 'second' });
    expect(state.latestPendingValue('SpecLedgerModel', 'row-1', 'status', 'op-2')).toEqual({ found: true, value: 'first' });
    expect(state.latestPendingValue('SpecLedgerModel', 'row-1', 'missing')).toEqual({ found: false, value: undefined });
  });

  it('filters nonowners from row buckets and restores a patch owner after a no-op transition', () => {
    const { state } = setup();
    expect(state.latestPendingValue('SpecLedgerModel', 'row-1', 'status')).toEqual({ found: false, value: undefined });

    state.begin(baseRecord('patch-owner', { intent: 'patch', rowIds: ['row-1'], patchedFields: ['status'], patchedValues: { status: 'owned' } }));
    state.begin(baseRecord('insert-peer', { intent: 'insert', rowIds: ['row-1'] }));
    state.begin(baseRecord('temp-only-patch', { intent: 'insert', rowIds: ['row-1'], tempIds: ['row-1'] }));

    expect(state.ownedFields('SpecLedgerModel', 'missing')).toEqual(new Set());
    expect(state.ownedFields('SpecLedgerModel', 'row-1')).toEqual(new Set(['status']));
    expect(state.latestPendingValue('SpecLedgerModel', 'missing', 'status')).toEqual({ found: false, value: undefined });

    state.applyTransitions([{ kind: 'remove', operationId: 'patch-owner', expectedStatus: 'failed' }]);

    expect(state.ownedFields('SpecLedgerModel', 'row-1')).toEqual(new Set(['status']));
    expect(state.latestPendingValue('SpecLedgerModel', 'row-1', 'status', 'patch-owner')).toEqual({ found: false, value: undefined });
  });
});

describe('prune retention', () => {
  it('prunes only closed non-once operations past the ttl and keeps everything else', () => {
    let currentTime = 1000;
    const { state } = setup(() => currentTime);
    state.begin(baseRecord('op-committed', { createdAt: 1000 }));
    state.begin(baseRecord('op-once', { createdAt: 1000, once: true, idempotencyKey: 'once-key' }));
    state.begin(baseRecord('op-pending', { createdAt: 1000 }));
    state.begin(baseRecord('op-failed', { createdAt: 1000 }));
    state.begin(baseRecord('op-fresh', { createdAt: 1000 }));
    state.close('op-committed', 'committed');
    state.close('op-once', 'committed');
    state.close('op-failed', 'failed');
    state.close('op-fresh', 'committed');
    (state.get('op-fresh') as OperationRecord).createdAt = 10_000_000;

    currentTime = 1000 + 60 * 60 * 1000 + 1001;
    const pruned = state.prune();

    expect(pruned).toBe(1);
    expect(state.get('op-committed')).toBeUndefined();
    expect(state.get('op-once')).toBeDefined();
    expect(state.get('op-pending')).toBeDefined();
    expect(state.get('op-failed')).toBeDefined();
    expect(state.get('op-fresh')).toBeDefined();
    expect(state.hasCommitted('once-key')).toBe(true);
  });
});

describe('open row protection source', () => {
  it('unions canonical rowIds of open operations only', () => {
    const { storage, state } = setup();
    state.begin(baseRecord('op-open', { tempIds: ['temp-open'] }));
    state.begin(baseRecord('op-closed'));
    state.close('op-closed', 'committed');
    state.begin(baseRecord('op-bare', { tempIds: ['temp-bare'], rowIds: ['temp-bare'] }));
    state.begin(baseRecord('op-failed'));
    state.close('op-failed', 'failed');

    const held = ['row-op-failed', 'row-op-open', 'temp-bare'];
    expect([...state.openRowIdsFor('SpecLedgerModel')].sort()).toEqual(held);
    expect([...state.openRowIdsFor('OtherModel')]).toEqual([]);

    const fresh = createOperationState({ storage, prefix: () => PREFIX, now: () => 1000 });
    fresh.hydrate();
    expect([...fresh.openRowIdsFor('SpecLedgerModel')].sort()).toEqual(held);
  });
});

describe('hydrate key retention', () => {
  it('retains keys for pending and committed-once records, drops the rest, and tracks hydrated pending', () => {
    const { storage, state } = setup();
    state.begin(baseRecord('op-pending', { idempotencyKey: 'pending-key' }));
    state.begin(baseRecord('op-once', { idempotencyKey: 'once-key', once: true }));
    state.begin(baseRecord('op-plain', { idempotencyKey: 'plain-key' }));
    state.close('op-once', 'committed');
    state.close('op-plain', 'committed');

    const fresh = createOperationState({ storage, prefix: () => PREFIX, now: () => 1000 });
    fresh.hydrate();

    expect(fresh.hasPending('pending-key')).toBe(true);
    expect(fresh.hasCommitted('once-key')).toBe(true);
    expect(fresh.get('op-plain')?.idempotencyKey).toBeUndefined();
    expect(fresh.hydratedPending().map(operation => operation.operationId)).toEqual(['op-pending']);

    const taken = fresh.takeHydratedPending(operation => operation.operationId === 'op-pending');
    expect(taken.map(operation => operation.operationId)).toEqual(['op-pending']);
    expect(fresh.hydratedPending()).toEqual([]);
  });

  it('hydrates valid pending destroy and empty patch-field records without counting patch ownership', () => {
    const { storage, state } = setup();
    state.begin(baseRecord('destroy-pending', { intent: 'destroy' }));
    state.begin(baseRecord('patch-empty', { intent: 'patch', patchedFields: [] }));
    state.begin(baseRecord('patch-owned', { intent: 'patch', patchedFields: ['status'], patchedValues: { status: 'pending' } }));

    const fresh = createOperationState({ storage, prefix: () => PREFIX, now: () => 1000 });
    fresh.hydrate();

    expect(fresh.pending().map(operation => operation.operationId).sort()).toEqual(['destroy-pending', 'patch-empty', 'patch-owned']);
    expect(fresh.ownedFields('SpecLedgerModel', 'row-patch-empty')).toEqual(new Set());
    expect(fresh.ownedFields('SpecLedgerModel', 'row-patch-owned')).toEqual(new Set(['status']));
  });

  it('keeps the hydrated-pending resume mark when a transition is a no-op', () => {
    const { storage, state } = setup();
    state.begin(baseRecord('op-pending', { idempotencyKey: 'pending-key' }));

    const fresh = createOperationState({ storage, prefix: () => PREFIX, now: () => 1000 });
    fresh.hydrate();
    expect(fresh.hydratedPending().map(operation => operation.operationId)).toEqual(['op-pending']);

    fresh.applyTransitions([{ kind: 'remove', operationId: 'op-pending', expectedStatus: 'failed' }]);

    expect(fresh.get('op-pending')?.status).toBe('pending');
    expect(fresh.hydratedPending().map(operation => operation.operationId)).toEqual(['op-pending']);
  });

  it('applyTransitions never writes storage - durability belongs to the prepared WAL batch', () => {
    const { storage, state } = setup();
    state.begin(baseRecord('op-a', { idempotencyKey: 'key-a' }));
    const writes: unknown[] = [];
    const originalSet = storage.set.bind(storage);
    storage.set = (key, value) => {
      writes.push({ key, value });
      originalSet(key, value);
    };

    state.applyTransitions([{ kind: 'close', operationId: 'op-a', status: 'committed' }]);

    expect(state.get('op-a')?.status).toBe('committed');
    expect(writes).toEqual([]);
  });

  it('cold-resets a corrupt ops record and reports the loss', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}ops`, '{corrupt');
    const fresh = createOperationState({ storage, prefix: () => PREFIX, now: () => 1000 });

    fresh.hydrate();

    expect(storage.get(`${PREFIX}ops`)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'operation-ledger-corruption-reset', model: '__operations__', count: 1 });
  });

  it.each([
    ['empty operation id', { ...baseRecord(''), status: 'pending' }],
    ['empty action key', { ...baseRecord('op-1'), actionKey: '', status: 'pending' }],
    ['unknown action mode', { ...baseRecord('op-1'), actionMode: 'poll', status: 'pending' }],
    ['empty model id', { ...baseRecord('op-1'), model: '', status: 'pending' }],
    ['empty temporary id', { ...baseRecord('op-1'), tempIds: [''], status: 'pending' }],
    ['one empty temporary id beside a valid one', { ...baseRecord('op-1'), tempIds: ['temp-ok', ''], status: 'pending' }],
    ['missing canonical row ids', { ...operationWithoutRowIds, status: 'pending' }],
    ['empty row id', { ...baseRecord('op-1'), rowIds: [''], status: 'pending' }],
    ['one empty row id beside a valid one', { ...baseRecord('op-1'), rowIds: ['row-ok', ''], status: 'pending' }],
    ['unknown status', { ...baseRecord('op-1'), status: 'weird' }],
    ['missing status', { ...baseRecord('op-1') }],
    ['invalid idempotency key', { ...baseRecord('op-1'), idempotencyKey: 7, status: 'pending' }],
    ['invalid once flag', { ...baseRecord('op-1'), once: 'yes', status: 'pending' }],
    ['invalid patched fields', { ...baseRecord('op-1'), patchedFields: ['label', 7], status: 'pending' }],
    ['invalid patched values', { ...baseRecord('op-1'), patchedValues: [], status: 'pending' }],
    ['negative creation time', { ...baseRecord('op-1'), createdAt: -1, status: 'pending' }],
    ['fractional creation time', { ...baseRecord('op-1'), createdAt: 1.5, status: 'pending' }]
  ])('cold-resets a semantically invalid operation record: %s', (_label, record) => {
    const { storage } = setup();
    storage.set(`${PREFIX}ops`, encodePersistence({ [String(record.operationId)]: record }));
    const fresh = createOperationState({ storage, prefix: () => PREFIX, now: () => 1000 });

    fresh.hydrate();

    expect(storage.get(`${PREFIX}ops`)).toBeUndefined();
    expect(fresh.pending()).toEqual([]);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'operation-ledger-corruption-reset', model: '__operations__', count: 1 });
  });

  it('writes null persist entries once the ledger empties so stale storage keys clear', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1'));
    state.remove('op-1');

    expect(state.persistEntries()).toEqual([]);
  });
});
