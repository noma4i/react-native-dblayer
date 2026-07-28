import { configureDb } from '../../../index';
import { createOperationState, readCommittedOnceKeys, serializeOperationInput } from '../../../core/planes/operationState';
import type { OperationRecord } from '../../../types';
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
  model: 'SpecLedgerModel',
  tempIds: [],
  rowIds: [`row-${operationId}`],
  intent: 'insert',
  createdAt: 1000,
  ...overrides
});

const setup = (nowValue = () => 1000) => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() });
  diagnostics().reset();
  const state = createOperationState({ storage, prefix: () => PREFIX, now: nowValue });
  return { storage, state };
};

describe('committed once-key persistence format', () => {
  it('ignores a once-key record with a foreign format version or non-string keys', () => {
    const { storage } = setup();
    storage.set([{ key: `${PREFIX}ops-once`, value: JSON.stringify({ formatVersion: 99, keys: ['k1'] }) }]);
    expect(readCommittedOnceKeys(storage, PREFIX).keys).toEqual([]);

    storage.set([{ key: `${PREFIX}ops-once`, value: JSON.stringify({ formatVersion: 1, keys: ['k1', 7] }) }]);
    expect(readCommittedOnceKeys(storage, PREFIX).keys).toEqual([]);

    storage.set([{ key: `${PREFIX}ops-once`, value: JSON.stringify({ formatVersion: 1, keys: ['k2', 'k1'] }) }]);
    expect(readCommittedOnceKeys(storage, PREFIX).keys).toEqual(['k1', 'k2']);
  });

  it('collects only committed once operations with string keys from the ops record', () => {
    const { storage } = setup();
    const ops = {
      a: { status: 'committed', once: true, idempotencyKey: 'keep' },
      b: { status: 'pending', once: true, idempotencyKey: 'skip-pending' },
      c: { status: 'committed', once: false, idempotencyKey: 'skip-not-once' },
      d: { status: 'committed', once: true, idempotencyKey: 7 }
    };
    storage.set([{ key: `${PREFIX}ops`, value: JSON.stringify(ops) }]);

    expect(readCommittedOnceKeys(storage, PREFIX)).toEqual({ keys: ['keep'], corruptSources: 0 });
  });

  it('counts each corrupt source separately', () => {
    const { storage } = setup();
    storage.set([
      { key: `${PREFIX}ops-once`, value: '{corrupt' },
      { key: `${PREFIX}ops`, value: '{corrupt' }
    ]);

    expect(readCommittedOnceKeys(storage, PREFIX).corruptSources).toBe(2);
  });
});

describe('operation input serialization', () => {
  it('rejects non-JSON inputs: cycles, non-finite numbers, exotic prototypes, functions, undefined items', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializeOperationInput(cyclic).serializable).toBe(false);
    expect(serializeOperationInput(NaN).serializable).toBe(false);
    expect(serializeOperationInput(Infinity).serializable).toBe(false);
    expect(serializeOperationInput(new Date(5)).serializable).toBe(false);
    expect(serializeOperationInput(() => 1).serializable).toBe(false);
    expect(serializeOperationInput([undefined]).serializable).toBe(false);
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
});

describe('row buckets and patch ownership', () => {
  it('matches pendingForRow by rowIds when present, falling back to tempIds', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1', { tempIds: ['temp-1'], rowIds: ['row-1'] }));
    state.begin(baseRecord('op-2', { tempIds: ['temp-2'], rowIds: undefined }));

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

  it('cold-resets a corrupt ops record and reports the loss', () => {
    const { storage } = setup();
    storage.set([{ key: `${PREFIX}ops`, value: '{corrupt' }]);
    const fresh = createOperationState({ storage, prefix: () => PREFIX, now: () => 1000 });

    fresh.hydrate();

    expect(storage.get(`${PREFIX}ops`)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'operation-ledger-corruption-reset', model: '__operations__', count: 1 });
  });

  it('writes null persist entries once the ledger empties so stale storage keys clear', () => {
    const { state } = setup();
    state.begin(baseRecord('op-1'));
    state.remove('op-1');

    expect(state.persistEntries()).toEqual([
      { key: `${PREFIX}ops`, value: null },
      { key: `${PREFIX}ops-once`, value: null }
    ]);
  });
});
