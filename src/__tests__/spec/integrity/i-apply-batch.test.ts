import { configureDb, resetRuntime } from '../../../index';
import { createApplyRuntime, createCommitEnvelope, registerApplyTarget } from '../../../core/apply/transaction';
import { createCommitBus } from '../../../core/apply/commitBus';
import { createJournal } from '../../../core/apply/journal';
import { encodePersistence } from '../../../core/persistenceCodec';
import { createModelStore, registerModelStoreFactory } from '../../../core/store';
import type { ApplyTarget, CheckpointScheduler, IncrementalCommitBatch, JournalRecord, StoredRow, WriteOp } from '../../../types';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

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
    readScopeOrder: () => [],
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
  return (record.status === 'pending' ? journal.pendingEntry(record) : journal.committedEntry(record))[0]!.value!;
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

  it('applies entity work before scope membership inside one commit', () => {
    const { storage, mock, bus } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: WriteOp[] = [
      { kind: 'scope', model: MODEL, scopeKey: 'scope-1', next: ['row-1'] as never },
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
        append: [
          { id: 'row-c', order: 7 },
          { id: 'row-d' }
        ],
        detach: ['row-e']
      },
      { kind: 'scope', model: MODEL, scopeKey: 'scope-1', next: [] as never }
    ];

    runtime.commit(createCommitEnvelope(ops));

    const changes = published[0]!.scopeChanges!;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      model: MODEL,
      scopeKey: 'scope-1',
      ids: ['row-a', 'row-b'],
      appendIds: ['row-c', 'row-d'],
      appendEntries: [{ id: 'row-c', order: 7 }],
      detachIds: ['row-e'],
      rebuild: true
    });
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

  it('treats a garbage applied-epoch marker as zero and replays the record', () => {
    const { storage, mock, bus } = setup();
    const firstRuntime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    firstRuntime.commit(createCommitEnvelope([{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }] }]));
    mock.rows.clear();
    mock.calls.length = 0;
    storage.set([
      { key: `${PREFIX}applied:${MODEL}`, value: 'garbage' }
    ]);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    expect(runtime.replay()).toBe(1);
    expect(mock.calls.some(call => call.op === 'put')).toBe(true);
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
