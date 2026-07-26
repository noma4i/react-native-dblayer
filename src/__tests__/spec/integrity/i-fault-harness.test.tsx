import { configureDb, defineModel, f } from '../../../index';
import { flushPersistence } from '../../../dsl/configure';
import { createApplyRuntime } from '../../../core/apply/transaction';
import { createCommitBus } from '../../../core/apply/commitBus';
import { createFaultStorage } from '../helpers/faultStorage';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { createMockTransport, renderCountedInProvider, settle } from '../helpers/harness';

type FaultRow = { id: string; label: string };
type FaultResponse = { detail: FaultRow };

const document = { kind: 'Document', definitions: [] } as never;

const createRows = (suffix: string) =>
  defineModel({
    id: `SpecFaultRows${suffix}`,
    name: `SpecFaultRows${suffix}`,
    fields: { label: f.str() }
  });

const configureFaultRuntime = (storage: ReturnType<typeof createFaultStorage>) => {
  configureDb({
    storage: storage.plane,
    transport: createMockTransport(),
    defaults: { persistence: { checkpointDelayMs: 60_000, maxPendingPlans: 100 } }
  });
};

describe('fault storage harness', () => {
  it('fails configured batches before writes, truncates one batch, corrupts values, and records batch order', () => {
    const storage = createFaultStorage();

    storage.failNextSet();
    expect(() => storage.plane.set([{ key: 'one', value: '1' }])).toThrow('fault: set failed');
    expect(storage.plane.get('one')).toBeUndefined();
    storage.plane.set([{ key: 'one', value: '1' }]);

    storage.truncateNextSet(1);
    expect(() => storage.plane.set([{ key: 'two', value: '2' }, { key: 'three', value: '3' }])).toThrow('fault: set truncated');
    expect(storage.plane.get('two')).toBe('2');
    expect(storage.plane.get('three')).toBeUndefined();

    storage.corrupt('one');
    expect(storage.plane.get('one')).toBe('{corrupt');
    expect(storage.setCalls()).toEqual([
      [{ key: 'one', value: '1' }],
      [{ key: 'one', value: '1' }],
      [
        { key: 'two', value: '2' },
        { key: 'three', value: '3' }
      ]
    ]);
  });
});

describe('persistence fault invariants', () => {
  it('writes the pending journal record before applying an insert', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('WriteAhead');

    rows.insert({ id: 'row-1', label: 'local' });

    const journalKey = storage.plane.keys('dbl:journal:')[0];
    expect(journalKey).toBe('dbl:journal:1');
    const journal = JSON.parse(storage.plane.get(journalKey!)!) as { status: string; ops: Array<{ kind: string; model: string; rows?: FaultRow[] }> };
    expect(journal).toMatchObject({ status: 'committed', ops: [{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', label: 'local' }] }] });
    expect(JSON.parse(storage.setCalls()[0]![0]!.value!) as { status: string }).toMatchObject({ status: 'pending' });
  });

  it('retries a failed checkpoint with the original rows and applied marker intact', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('Retry');
    rows.insert({ id: 'row-1', label: 'local' });

    storage.failNextSet();
    expect(() => flushPersistence()).toThrow('fault: set failed');
    expect(storage.plane.get('dbl:journal:1')).not.toBeUndefined();

    flushPersistence();

    expect(storage.plane.get(`dbl:row:${rows.modelId}:row-1`)).toBe(JSON.stringify({ id: 'row-1', label: 'local' }));
    expect(storage.plane.get(`dbl:applied:${rows.modelId}`)).toBe('1');
  });

  it('retries a partially written checkpoint with every row and its applied marker', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('TruncatedRetry');
    rows.insertMany([
      { id: 'row-1', label: 'first' },
      { id: 'row-2', label: 'second' }
    ]);

    storage.truncateNextSet(1);
    expect(() => flushPersistence()).toThrow('fault: set truncated');
    expect(storage.plane.get(`dbl:row:${rows.modelId}:row-1`)).toBe(JSON.stringify({ id: 'row-1', label: 'first' }));
    expect(storage.plane.get(`dbl:row:${rows.modelId}:row-2`)).toBeUndefined();

    flushPersistence();

    expect(storage.plane.get(`dbl:row:${rows.modelId}:row-1`)).toBe(JSON.stringify({ id: 'row-1', label: 'first' }));
    expect(storage.plane.get(`dbl:row:${rows.modelId}:row-2`)).toBe(JSON.stringify({ id: 'row-2', label: 'second' }));
    expect(storage.plane.get(`dbl:applied:${rows.modelId}`)).toBe('1');
  });

  it('keeps committed WAL records through a failed flush and prunes the oldest record after a successful checkpoint', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('PruneSafety');
    for (let index = 0; index < 51; index += 1) rows.insert({ id: `row-${index}`, label: String(index) });

    storage.failNextSet();
    expect(() => flushPersistence()).toThrow('fault: set failed');
    expect(storage.plane.get('dbl:journal:1')).not.toBeUndefined();

    flushPersistence();

    expect(storage.plane.get('dbl:journal:1')).toBeUndefined();
    expect(storage.plane.keys('dbl:journal:')).toHaveLength(50);
  });

  it('does not advance the prune checkpoint after a failed checkpoint write', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('FailedCheckpointPruneGate');
    rows.insert({ id: 'row-0', label: '0' });

    storage.failNextSet();
    expect(() => flushPersistence()).toThrow('fault: set failed');

    for (let index = 1; index <= 50; index += 1) rows.insert({ id: `row-${index}`, label: String(index) });

    expect(storage.plane.get('dbl:journal:1')).not.toBeUndefined();
  });

  it('acknowledges immediate persistence before the next direct transaction', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('ImmediateAck');
    const runtime = createApplyRuntime({ storage: storage.plane, prefix: () => 'dbl:', bus: createCommitBus() });

    runtime.apply([{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', label: 'first' }] }]);
    runtime.apply([{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-2', label: 'second' }] }]);

    expect(storage.setCalls()[3]).toEqual(
      expect.arrayContaining([{ key: `dbl:row:${rows.modelId}:row-2`, value: JSON.stringify({ id: 'row-2', label: 'second' }) }])
    );
    expect(storage.setCalls()[3]).not.toEqual(expect.arrayContaining([{ key: `dbl:row:${rows.modelId}:row-1`, value: JSON.stringify({ id: 'row-1', label: 'first' }) }]));
  });

  it('does not replay a journal record already covered by its applied marker', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('ReplayCoverage');
    storage.plane.set([
      { key: `dbl:applied:${rows.modelId}`, value: '1' },
      { key: 'dbl:journal:1', value: JSON.stringify({ epoch: 1, status: 'committed', ops: [{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', label: 'persisted' }] }] }) }
    ]);
    const bus = createCommitBus();
    const batches: unknown[] = [];
    bus.subscribeAll(batch => batches.push(batch));
    const runtime = createApplyRuntime({ storage: storage.plane, prefix: () => 'dbl:', bus });

    expect(runtime.replay()).toBe(0);
    expect(batches).toEqual([]);
  });

  it('rejects a server snapshot after destroy but lets an event-origin insert restore the row', async () => {
    const storage = createFaultStorage();
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { detail: { id: 'row-1', label: 'server' } } as TData }) });
    configureDb({ storage: storage.plane, transport, defaults: { persistence: { checkpointDelayMs: 60_000, maxPendingPlans: 100 } } });
    const rows = createRows('Tombstone');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });
    const query = rows.query<FaultResponse, { id: string }, { id: string }, FaultRow>('detail', {
      document,
      key: 'fault-tombstone-detail',
      vars: scope => scope,
      select: data => data.detail,
      staleTime: Infinity
    });

    rows.insert({ id: 'row-1', label: 'local' });
    rows.destroy('row-1');
    const reader = renderCountedInProvider(() => query.use({ id: 'row-1' }));
    await settle();
    await settle(1, { macro: true });

    expect(rows.find('row-1')).toBeUndefined();
    rows.insert({ id: 'row-1', label: 'event' });
    expect(rows.find('row-1')).toEqual({ id: 'row-1', label: 'event' });
    flushPersistence();
    expect(storage.plane.get(`dbl:tombstones:${rows.modelId}`)).toBeUndefined();
    reader.unmount();
  });
});
