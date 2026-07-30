import { configureDb, registerRelationHost, resetRuntime } from '../../testApi';
import { registerApplyTarget } from '../../../core/apply/applyTargetRegistry';
import { createCommitEnvelope } from '../../../core/apply/commitEnvelope';
import { createApplyRuntime } from '../../../core/apply/transaction';
import { createCommitBus } from '../../../core/apply/commitBus';
import { createJournal } from '../../../core/apply/journal';
import { encodePersistence } from '../../../core/persistenceCodec';
import { createModelStore, registerModelStoreFactory } from '../../../core/store';
import type { ApplyTarget, CheckpointScheduler, IncrementalCommitBatch, JournalRecord, RelationHost, StoredRow, WriteOp } from '../../../types';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

/**
 * Apply-pipeline batch contracts over a mock target: entity-before-scope ordering, scope-change
 * aggregation, counter compilation, replay epoch guards, and checkpoint pruning. The mutation
 * audit left these branches unkilled (41% score) - they are the durable WAL surface that SURVIVES
 * the tanstack migration, so each guarantee is pinned here at the unit seam.
 */
const MODEL = 'SpecApplyModel';
const PREFIX = 'dbl:';

type Call = { op: string; args: unknown[] };

const createTargetMock = () => {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  const target: ApplyTarget = {
    readRow: id => rows.get(id),
    readAllRows: () => [...rows.values()],
    readScopeEntries: () => [],
    planScopePlacement: (_scopeKey, ids) => ids.map((id, index) => ({ id, orderKey: `P${index}` })),
    readScopeOrderRevision: () => 0,
    readScopeGeneration: () => 0,
    scopeOrderAffected: () => false,
    scopeSortMeta: () => ({ kind: 'server-order' }),
    readAllScopeKeys: () => [],
    prepareUpsert: (incoming, previous) => {
      const row: StoredRow = { ...previous, ...(incoming as StoredRow), id: String((incoming as { id: unknown }).id) };
      return { row, changedFields: previous ? Object.keys(row).filter(field => !Object.is(previous[field], row[field])) : null };
    },
    preparePatch: (id, patch, previous) => {
      if (!previous) return null;
      const row: StoredRow = { ...previous, ...patch, id };
      return { row, changedFields: Object.keys(row).filter(field => !Object.is(previous[field], row[field])) };
    },
    beginApply: () => {},
    commitApply: () => {},
    abortApply: () => {},
    put: incoming => {
      calls.push({ op: 'put', args: [incoming] });
      return incoming.map(value => {
        const previous = rows.get(String(value.id));
        rows.set(String(value.id), value);
        return { id: String(value.id), changedFields: previous ? Object.keys(value).filter(field => !Object.is(previous[field], value[field])) : null };
      });
    },
    destroy: ids => {
      calls.push({ op: 'destroy', args: [ids] });
      for (const id of ids) rows.delete(id);
      return [...ids];
    },
    scope: scopeKey => {
      calls.push({ op: 'scope', args: [scopeKey] });
    },
    scopeDelta: (scopeKey, delta) => {
      calls.push({ op: 'scopeDelta', args: [scopeKey, delta] });
    },
    reactiveScopes: () => ['scope-1'],
    persistEntries: () => [],
    ackPersist: () => {
      calls.push({ op: 'ackPersist', args: [] });
    }
  };
  return { target, rows, calls };
};

const encodeJournalRecord = (record: JournalRecord): string => {
  const storage = createMemoryPlane();
  const journal = createJournal(storage, () => PREFIX);
  return (record.status === 'pending' ? journal.pendingEntry(record) : journal.committedEntry(record).entries)[0]!.value!;
};

const journalRecord = (epoch: number, status: 'pending' | 'committed', ops: JournalRecord['ops']): JournalRecord => ({
  txId: `test:${epoch}`,
  runtimeEpoch: 1,
  epoch,
  status,
  ops
});

const setup = () => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() });
  const mock = createTargetMock();
  registerApplyTarget(MODEL, mock.target);
  registerModelStoreFactory(MODEL, () =>
    createModelStore({ modelId: MODEL, now: () => Date.now(), storage, prefix: () => PREFIX, applyWriteGate: (_previous, incoming) => incoming })
  );
  const bus = createCommitBus();
  const published: IncrementalCommitBatch[] = [];
  bus.subscribeAll(batch => published.push(batch as IncrementalCommitBatch));
  return { storage, mock, bus, published };
};

describe('apply pipeline batching', () => {
  it('stamps the only constructible envelope format and rejects it after a runtime reset', () => {
    const { storage, bus } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const envelope = createCommitEnvelope([{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }]);

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      txId: expect.any(String),
      epoch: expect.any(Number)
    });

    resetRuntime();

    expect(() => runtime.commit(envelope)).toThrow(`Stale commit envelope ${envelope.txId}`);
    expect(storage.keys(`${PREFIX}journal:`)).toEqual([]);
  });

  it('rejects an envelope with an unsupported schema before writing WAL', () => {
    const { storage, bus } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const envelope = createCommitEnvelope([]);

    expect(() => runtime.commit({ ...envelope, schemaVersion: 2 } as never)).toThrow('Unsupported commit envelope schema version 2');
    expect(storage.keys(`${PREFIX}journal:`)).toEqual([]);
  });

  it('subscribes with an empty dependency set when dependencies are omitted', () => {
    setup();
    const bus = createCommitBus();
    const notify = jest.fn();

    const subscription = bus.subscribe(notify);

    expect(bus.subscriberCount()).toBe(1);
    expect(bus.activeDependencies()).toEqual([]);
    subscription.unsubscribe();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('applies entity work before scope membership inside one commit', () => {
    const { storage, mock, bus } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: WriteOp[] = [
      { kind: 'scope', model: MODEL, scopeKey: 'scope-1', next: { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: 'V' }] } },
      { kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }], origin: 'event' }
    ];

    runtime.commit(createCommitEnvelope(ops));

    const order = mock.calls.filter(call => call.op === 'put' || call.op === 'scope').map(call => call.op);
    expect(order).toEqual(['put', 'scope']);
  });

  it('aggregates every scope note of one commit into a single merged scope change', () => {
    const { storage, mock, bus, published } = setup();
    void mock;
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: WriteOp[] = [
      { kind: 'upsert', model: MODEL, rows: [{ id: 'row-a' }, { id: 'row-b' }], origin: 'event' },
      { kind: 'upsert', model: MODEL, rows: [{ id: 'row-b' }], origin: 'event' },
      {
        kind: 'scope-delta',
        model: MODEL,
        scopeKey: 'scope-1',
        append: [{ id: 'row-c', orderKey: '7' }, { id: 'row-d' }],
        detach: ['row-e']
      },
      { kind: 'scope', model: MODEL, scopeKey: 'scope-1', next: { generation: 2, coverage: 'complete', entries: [] } }
    ];

    runtime.commit(createCommitEnvelope(ops));

    const changes = published[0]!.scopeChanges!;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      model: MODEL,
      scopeKey: 'scope-1',
      entries: [],
      upserts: undefined,
      detachIds: undefined
    });
  });

  it('drops delta state accumulated before an authoritative full entry set of the same commit', () => {
    const { storage, bus, published } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: WriteOp[] = [
      { kind: 'scope-delta', model: MODEL, scopeKey: 'scope-1', append: [], detach: ['row-x'] },
      { kind: 'scope', model: MODEL, scopeKey: 'scope-1', next: { generation: 2, coverage: 'complete', entries: [{ id: 'row-x', orderKey: 'a' }] } }
    ];

    runtime.commit(createCommitEnvelope(ops));

    expect(published[0]!.scopeChanges).toEqual([
      { model: MODEL, scopeKey: 'scope-1', entries: [{ id: 'row-x', orderKey: 'a' }], upserts: undefined, detachIds: undefined }
    ]);
  });

  it('keeps delta state layered on top of an earlier full entry set of the same commit', () => {
    const { storage, bus, published } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: WriteOp[] = [
      { kind: 'scope', model: MODEL, scopeKey: 'scope-1', next: { generation: 2, coverage: 'complete', entries: [{ id: 'row-x', orderKey: 'a' }] } },
      { kind: 'scope-delta', model: MODEL, scopeKey: 'scope-1', append: [{ id: 'row-y', orderKey: 'b' }], detach: ['row-x'] }
    ];

    runtime.commit(createCommitEnvelope(ops));

    expect(published[0]!.scopeChanges).toEqual([
      { model: MODEL, scopeKey: 'scope-1', entries: [{ id: 'row-x', orderKey: 'a' }], upserts: [{ id: 'row-y', orderKey: 'b' }], detachIds: ['row-x'] }
    ]);
  });

  it('normalizes non-string ids across every plan branch so one overlay identity survives the batch', () => {
    const { mock } = setup();
    void mock;
    const ops: WriteOp[] = [
      { kind: 'upsert', model: MODEL, rows: [{ id: 42 }] },
      { kind: 'destroy', model: MODEL, ids: [42 as never] },
      { kind: 'patch', model: MODEL, id: '42', patch: { label: 'x' } }
    ];

    const envelope = createCommitEnvelope(ops);

    expect(envelope.entityOps.map(op => op.kind)).toEqual(['upsert', 'destroy']);
    const destroyOp = envelope.entityOps.find(op => op.kind === 'destroy');
    expect(destroyOp && destroyOp.kind === 'destroy' ? destroyOp.ids : []).toEqual(['42']);
  });

  it('escalates the published batch mode to replace when any upsert is a replace', () => {
    const { storage, bus, published } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    runtime.commit(createCommitEnvelope([{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }], origin: 'replace' }]));

    expect(published[0]!.mode).toBe('replace');
  });

  it('compiles chained counters into one callback-free effective row plan', () => {
    const { storage, mock, bus } = setup();
    mock.rows.set('row-1', { id: 'row-1', likes: 10, views: 94 });
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: WriteOp[] = [
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'likes', delta: 2 },
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'likes', delta: 3 },
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'views', delta: 5 },
      { kind: 'counter', model: MODEL, id: 'row-2', field: 'likes', delta: 1 }
    ];

    runtime.commit(createCommitEnvelope(ops));

    const persisted = JSON.parse(storage.get(`${PREFIX}journal:1`)!) as {
      payload: { ops: Array<{ payload: { kind: string; rows?: Array<Record<string, unknown>> } }> };
    };
    expect(persisted.payload.ops.map(op => op.payload)).toEqual([
      { kind: 'upsert', model: MODEL, rows: [{ id: 'row-1', likes: 12, views: 94 }] },
      { kind: 'upsert', model: MODEL, rows: [{ id: 'row-1', likes: 15, views: 94 }] },
      { kind: 'upsert', model: MODEL, rows: [{ id: 'row-1', likes: 15, views: 99 }] }
    ]);
  });

  it('normalizes nullable, numeric-string, and nonnumeric counter bases', () => {
    const { mock } = setup();
    mock.rows.set('null-row', { id: 'null-row', score: null });
    mock.rows.set('string-row', { id: 'string-row', score: '4' });
    mock.rows.set('invalid-row', { id: 'invalid-row', score: 'invalid' });

    const envelope = createCommitEnvelope([
      { kind: 'counter', model: MODEL, id: 'null-row', field: 'score', delta: 2 },
      { kind: 'counter', model: MODEL, id: 'string-row', field: 'score', delta: 3 },
      { kind: 'counter', model: MODEL, id: 'invalid-row', field: 'score', delta: 5 }
    ]);

    expect(envelope.entityOps).toEqual([
      { kind: 'upsert', model: MODEL, rows: [{ id: 'null-row', score: 2 }] },
      { kind: 'upsert', model: MODEL, rows: [{ id: 'string-row', score: 7 }] },
      { kind: 'upsert', model: MODEL, rows: [{ id: 'invalid-row', score: 5 }] }
    ]);
  });

  it('rejects a prepared upsert without a string id', () => {
    const { mock } = setup();
    mock.target.prepareUpsert = () => ({ row: { id: '' }, changedFields: null });

    expect(() => createCommitEnvelope([{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }])).toThrow(
      `Prepared row for ${MODEL} has no string id`
    );
  });

  it('passes invalid raw upsert shapes to model normalization without an overlay identity', () => {
    const { mock } = setup();
    const previousRows: Array<StoredRow | undefined> = [];
    mock.target.prepareUpsert = (_incoming, previous) => {
      previousRows.push(previous);
      return null;
    };

    expect(createCommitEnvelope([{ kind: 'upsert', model: MODEL, rows: [null, {}] }]).entityOps).toEqual([]);
    expect(previousRows).toEqual([undefined, undefined]);
  });

  it('plans dependent destroys against the row overlay and ignores malformed stored identities', () => {
    const parentModel = 'SpecApplyParent';
    const childModel = 'SpecApplyChild';
    const parent = createTargetMock();
    const child = createTargetMock();
    parent.rows.set('parent-1', { id: 'parent-1' });
    child.rows.set('old-child', { id: 'old-child', parentId: 'parent-1' });
    child.rows.set('malformed-child', { id: 42, parentId: 'parent-1' });
    registerApplyTarget(parentModel, parent.target);
    registerApplyTarget(childModel, child.target);
    const childRef = {
      modelId: childModel,
      find: (id: string | null | undefined) => (id == null ? undefined : child.rows.get(String(id))),
      all: () => [...child.rows.values()],
      where: (where: Record<string, unknown>) => [...child.rows.values()].filter(row => Object.entries(where).every(([key, value]) => row[key] === value))
    };
    const host: RelationHost = {
      relations: () => ({ children: { kind: 'hasMany', model: childRef, foreignKey: 'parentId', dependent: 'destroy' } }),
      read: id => parent.rows.get(id),
      membershipForUpsert: () => [],
      detachForDestroy: () => []
    };
    registerRelationHost(parentModel, host);

    const envelope = createCommitEnvelope([
      { kind: 'upsert', model: childModel, rows: [{ id: 'new-child', parentId: 'parent-1' }] },
      { kind: 'destroy', model: childModel, ids: ['old-child'] },
      { kind: 'destroy', model: parentModel, ids: ['parent-1'] }
    ]);

    expect(envelope.entityOps).toContainEqual({ kind: 'destroy', model: childModel, ids: ['new-child'] });
    expect(envelope.entityOps.flatMap(op => (op.kind === 'destroy' ? op.ids : []))).not.toContain('42');
  });

  it('commits a target that does not expose reactive scopes', () => {
    const model = 'SpecApplyWithoutReactiveScopes';
    const mock = createTargetMock();
    delete mock.target.reactiveScopes;
    registerApplyTarget(model, mock.target);
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    registerApplyTarget(model, mock.target);
    registerModelStoreFactory(model, () =>
      createModelStore({ modelId: model, now: () => Date.now(), storage, prefix: () => PREFIX, applyWriteGate: (_previous, incoming) => incoming })
    );
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus: createCommitBus() });

    runtime.commit(createCommitEnvelope([{ kind: 'upsert', model, rows: [{ id: 'row-1' }] }]));

    expect(mock.rows.get('row-1')).toEqual({ id: 'row-1' });
  });

  it('treats a garbage applied-epoch marker as zero and replays the record', () => {
    const { storage, mock, bus } = setup();
    diagnostics().reset();
    const firstRuntime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    firstRuntime.commit(createCommitEnvelope([{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }]));
    mock.rows.clear();
    mock.calls.length = 0;
    storage.set([{ key: `${PREFIX}applied:${MODEL}`, value: 'garbage' }]);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    expect(runtime.replay()).toBe(1);
    expect(mock.calls.some(call => call.op === 'put')).toBe(true);
    expect(storage.get(`${PREFIX}applied:${MODEL}`)).toBe(encodePersistence(1));
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-applied-epoch', model: MODEL, count: 1 });
  });

  it.each([-1, 1.5])('rejects an invalid applied epoch marker and replays conservatively: %s', invalidEpoch => {
    const { storage, mock, bus } = setup();
    diagnostics().reset();
    storage.set([
      {
        key: `${PREFIX}journal:1`,
        value: encodeJournalRecord(journalRecord(1, 'pending', [{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }]))
      },
      { key: `${PREFIX}applied:${MODEL}`, value: encodePersistence(invalidEpoch) }
    ]);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    expect(runtime.replay()).toBe(1);
    expect(mock.calls.some(call => call.op === 'put')).toBe(true);
    expect(storage.get(`${PREFIX}applied:${MODEL}`)).toBe(encodePersistence(1));
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-applied-epoch', model: MODEL, count: 1 });
  });

  it('preserves an unsupported applied-epoch version and stops replay for migration', () => {
    const { storage, bus } = setup();
    const markerKey = `${PREFIX}applied:${MODEL}`;
    storage.set([
      {
        key: `${PREFIX}journal:1`,
        value: encodeJournalRecord(journalRecord(1, 'pending', [{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }]))
      },
      { key: markerKey, value: encodePersistence(0, 2) }
    ]);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    expect(() => runtime.replay()).toThrow('Unsupported persistence schema version 2');
    expect(storage.get(markerKey)).toBeDefined();
  });

  it('marks an already-applied pending record committed without re-applying it', () => {
    const { storage, mock, bus } = setup();
    storage.set([
      {
        key: `${PREFIX}journal:3`,
        value: encodeJournalRecord(journalRecord(3, 'pending', [{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }]))
      },
      { key: `${PREFIX}applied:${MODEL}`, value: encodePersistence(5) }
    ]);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    expect(runtime.replay()).toBe(0);
    expect(mock.calls.some(call => call.op === 'put')).toBe(false);
    expect((JSON.parse(storage.get(`${PREFIX}journal:3`)!) as { payload: { status: string } }).payload.status).toBe('committed');
    expect(runtime.currentEpoch()).toBe(3);
  });

  it('prunes checkpointed committed records once the flush callback reports the flushed epoch', () => {
    const { storage, bus } = setup();
    storage.set(
      Array.from({ length: 51 }, (_, index) => ({
        key: `${PREFIX}journal:${index + 1}`,
        value: encodeJournalRecord(journalRecord(index + 1, 'committed', []))
      }))
    );
    let afterFlush: ((epoch: number) => void) | null = null;
    const checkpoint: CheckpointScheduler = {
      setAfterFlush: (callback: (epoch: number) => void) => {
        afterFlush = callback;
      },
      flushedEpoch: () => 0,
      notePlan: () => {},
      flushNow: () => Promise.resolve(),
      stop: () => {}
    } as unknown as CheckpointScheduler;
    createApplyRuntime({ storage, prefix: () => PREFIX, bus, checkpoint });

    afterFlush!(51);

    expect(storage.get(`${PREFIX}journal:1`)).toBeUndefined();
    expect(storage.get(`${PREFIX}journal:2`)).toBeDefined();
  });
});
