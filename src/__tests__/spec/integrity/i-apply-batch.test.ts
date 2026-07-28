import { configureDb } from '../../../index';
import { createApplyRuntime, createCommitEnvelope, registerApplyTarget } from '../../../core/apply/transaction';
import { createCommitBus } from '../../../core/apply/commitBus';
import type { ApplyTarget, CheckpointScheduler, IncrementalCommitBatch, JournalOp } from '../../../types';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

/**
 * Apply-pipeline batch contracts over a mock target: entity-before-scope ordering, scope-change
 * aggregation, journal counter stamping, replay epoch guards, and checkpoint pruning. The mutation
 * audit left these branches unkilled (41% score) - they are the durable WAL surface that SURVIVES
 * the tanstack migration, so each guarantee is pinned here at the unit seam.
 */
const MODEL = 'SpecApplyModel';
const PREFIX = 'dbl:';

type Call = { op: string; args: unknown[] };

const createTargetMock = () => {
  const rows = new Map<string, Record<string, unknown>>();
  const counters = new Map<string, number>();
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
    upsert: (incoming, origin) => {
      calls.push({ op: 'upsert', args: [incoming, origin] });
      const changes: Array<{ id: string; changedFields: string[] | null }> = [];
      for (const value of incoming as Array<{ id: string }>) {
        rows.set(value.id, value as Record<string, unknown>);
        changes.push({ id: value.id, changedFields: Object.keys(value) });
      }
      return changes;
    },
    patch: id => {
      calls.push({ op: 'patch', args: [id] });
      return null;
    },
    destroy: ids => {
      calls.push({ op: 'destroy', args: [ids] });
      for (const id of ids) rows.delete(id);
      return [...ids];
    },
    counter: (id, field, delta, next) => {
      calls.push({ op: 'counter', args: [id, field, delta, next] });
      return true;
    },
    counterValue: (id, field) => counters.get(`${id}:${field}`) ?? null,
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
  return { target, rows, counters, calls };
};

const setup = () => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() });
  const mock = createTargetMock();
  registerApplyTarget(MODEL, mock.target);
  const bus = createCommitBus();
  const published: IncrementalCommitBatch[] = [];
  bus.subscribeAll(batch => published.push(batch as IncrementalCommitBatch));
  return { storage, mock, bus, published };
};

describe('apply pipeline batching', () => {
  it('applies entity work before scope membership inside one commit', () => {
    const { storage, mock, bus } = setup();
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: JournalOp[] = [
      { kind: 'scope', model: MODEL, scopeKey: 'scope-1', next: ['row-1'] as never },
      { kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }], origin: 'event' }
    ];

    runtime.commit(createCommitEnvelope(ops));

    const order = mock.calls.filter(call => call.op === 'upsert' || call.op === 'scope').map(call => call.op);
    expect(order).toEqual(['upsert', 'scope']);
  });

  it('aggregates every scope note of one commit into a single merged scope change', () => {
    const { storage, mock, bus, published } = setup();
    void mock;
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: JournalOp[] = [
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

  it('stamps chained counter values into the journal and leaves explicit or unknown counters alone', () => {
    const { storage, mock, bus } = setup();
    mock.counters.set('row-1:likes', 10);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });
    const ops: JournalOp[] = [
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'likes', delta: 2 },
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'likes', delta: 3 },
      { kind: 'counter', model: MODEL, id: 'row-1', field: 'views', delta: 5, next: 99 },
      { kind: 'counter', model: MODEL, id: 'row-2', field: 'likes', delta: 1 }
    ];

    runtime.commit(createCommitEnvelope(ops));

    const record = JSON.parse(storage.get(`${PREFIX}journal:1`)!) as { ops: Array<{ next?: number }> };
    expect(record.ops[0]!.next).toBe(12);
    expect(record.ops[1]!.next).toBe(15);
    expect(record.ops[2]!.next).toBe(99);
    expect(record.ops[3]!.next).toBeUndefined();
  });

  it('treats a garbage applied-epoch marker as zero and replays the record', () => {
    const { storage, mock, bus } = setup();
    storage.set([
      { key: `${PREFIX}journal:1`, value: JSON.stringify({ epoch: 1, status: 'committed', ops: [{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }], origin: 'event' }] }) },
      { key: `${PREFIX}applied:${MODEL}`, value: 'garbage' }
    ]);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    expect(runtime.replay()).toBe(1);
    expect(mock.calls.some(call => call.op === 'upsert')).toBe(true);
  });

  it('marks an already-applied pending record committed without re-applying it', () => {
    const { storage, mock, bus } = setup();
    storage.set([
      { key: `${PREFIX}journal:3`, value: JSON.stringify({ epoch: 3, status: 'pending', ops: [{ kind: 'upsert', model: MODEL, rows: [{ id: 'row-1' }], origin: 'event' }] }) },
      { key: `${PREFIX}applied:${MODEL}`, value: '5' }
    ]);
    const runtime = createApplyRuntime({ storage, prefix: () => PREFIX, bus });

    expect(runtime.replay()).toBe(0);
    expect(mock.calls.some(call => call.op === 'upsert')).toBe(false);
    expect((JSON.parse(storage.get(`${PREFIX}journal:3`)!) as { status: string }).status).toBe('committed');
    expect(runtime.currentEpoch()).toBe(3);
  });

  it('prunes checkpointed committed records once the flush callback reports the flushed epoch', () => {
    const { storage, bus } = setup();
    storage.set(
      Array.from({ length: 51 }, (_, index) => ({
        key: `${PREFIX}journal:${index + 1}`,
        value: JSON.stringify({ epoch: index + 1, status: 'committed', ops: [] })
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
