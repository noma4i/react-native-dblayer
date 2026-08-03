import {
  configureDb,
  defineModelRuntime,
  f,
  flushPersistence,
  createCommitEnvelope,
  createApplyRuntime,
  createCommitBus,
  createJournal,
  encodePersistence,
  DB_FORMAT_VERSION,
  computeSchemaFingerprints,
  writePersistenceManifest
} from '../../testApi';
import { createFaultStorage, failAfterSettledBatches } from '../helpers/faultStorage';
import { compositeStorageKey, createMockTransport, diagnostics, renderCountedInProvider, settle } from '../helpers/harness';

type FaultRow = { id: string; label: string };
type FaultResponse = { detail: FaultRow };

const document = { kind: 'Document', definitions: [] } as never;

const createRows = (suffix: string) =>
  defineModelRuntime({
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
  it('fails configured writes, corrupts values, and records physical write order', () => {
    const storage = createFaultStorage();

    storage.failNextSet();
    expect(() => storage.plane.set('one', '1')).toThrow('fault: set failed');
    expect(storage.plane.get('one')).toBeUndefined();
    storage.plane.set('one', '1');

    storage.plane.set('two', '2');
    storage.plane.set('three', '3');
    expect(storage.plane.get('two')).toBe('2');
    expect(storage.plane.get('three')).toBe('3');

    storage.corrupt('one');
    expect(storage.plane.get('one')).toBe('{corrupt');
    expect(storage.setCalls()).toEqual([
      { key: 'one', value: '1' },
      { key: 'one', value: '1' },
      { key: 'two', value: '2' },
      { key: 'three', value: '3' }
    ]);
  });
});

describe('persistence fault invariants', () => {
  it('reports tombstone expiry before deleting the retention guard', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const storage = createFaultStorage();
      configureFaultRuntime(storage);
      const rows = createRows('TombstoneExpiry');
      diagnostics().reset();
      rows.insert({ id: 'row-1', label: 'local' });
      rows.destroy('row-1');
      clock.mockReturnValue(24 * 60 * 60 * 1000 + 1);

      flushPersistence();

      expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'tombstone-expiry', model: rows.modelId, count: 1 });
    } finally {
      clock.mockRestore();
    }
  });

  it('writes the immutable journal record before applying an insert', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('WriteAhead');

    rows.insert({ id: 'row-1', label: 'local' });

    const journalKey = storage.plane.keys('dbl:journal:')[0];
    expect(journalKey).toBe('dbl:journal:1');
    const journal = JSON.parse(storage.plane.get(journalKey!)!) as {
      payload: { ops: Array<{ payload: { kind: string; model: string; rows?: FaultRow[] } }> };
    };
    expect(journal.payload).toMatchObject({
      ops: [{ payload: { kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', label: 'local' }] } }]
    });
    expect(storage.setCalls()[0]!.key).toBe('dbl:journal:1');
  });

  it('stores row work and its operation transition in one immutable WAL value', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('TransitionEnvelope');
    const runtime = createApplyRuntime({ storage: storage.plane, prefix: () => 'dbl:', bus: createCommitBus() });

    runtime.commit(
      createCommitEnvelope(
        [{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'temp-1', label: 'pending' }] }],
        [
          {
            kind: 'begin',
            operation: {
              operationId: 'operation-1',
              actionKey: 'send',
              actionMode: 'durable',
              model: rows.modelId,
              tempIds: ['temp-1'],
              rowIds: ['temp-1'],
              intent: 'insert',
              createdAt: 1
            }
          }
        ]
      )
    );

    expect(storage.setCalls()[0]!.key).toBe('dbl:journal:1');
    expect(JSON.parse(storage.setCalls()[0]!.value!) as { payload: unknown }).toMatchObject({
      payload: {
        ops: [{ payload: { kind: 'upsert', model: rows.modelId } }],
        operationTransitions: [{ payload: { kind: 'begin', operation: { operationId: 'operation-1' } } }]
      }
    });
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

    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1'))).toBe(encodePersistence({ id: 'row-1', label: 'local' }));
    expect(storage.plane.get(`dbl:applied:${rows.modelId}`)).toBe(encodePersistence(1));
  });

  it('retries a partially written checkpoint with every row and its applied marker', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('TruncatedRetry');
    rows.insertMany([
      { id: 'row-1', label: 'first' },
      { id: 'row-2', label: 'second' }
    ]);

    failAfterSettledBatches(storage, 1);
    expect(() => flushPersistence()).toThrow('fault: set failed');
    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1'))).toBe(encodePersistence({ id: 'row-1', label: 'first' }));
    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-2'))).toBeUndefined();

    flushPersistence();

    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1'))).toBe(encodePersistence({ id: 'row-1', label: 'first' }));
    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-2'))).toBe(encodePersistence({ id: 'row-2', label: 'second' }));
    expect(storage.plane.get(`dbl:applied:${rows.modelId}`)).toBe(encodePersistence(1));
  });

  it('keeps WAL records through a failed flush and deletes every covered record after checkpoint', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('PruneSafety');
    for (let index = 0; index < 51; index += 1) rows.insert({ id: `row-${index}`, label: String(index) });

    storage.failNextSet();
    expect(() => flushPersistence()).toThrow('fault: set failed');
    expect(storage.plane.get('dbl:journal:1')).not.toBeUndefined();

    flushPersistence();

    expect(storage.plane.get('dbl:journal:1')).toBeUndefined();
    expect(storage.plane.keys('dbl:journal:')).toHaveLength(0);
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

    runtime.commit(createCommitEnvelope([{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', label: 'first' }] }]));
    runtime.commit(createCommitEnvelope([{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-2', label: 'second' }] }]));

    const secondJournalIndex = storage.setCalls().findIndex(write => write.key === 'dbl:journal:2');
    const secondWrites = storage.setCalls().slice(secondJournalIndex + 1);
    expect(secondWrites).toContainEqual({
      key: compositeStorageKey('dbl:', 'row', rows.modelId, 'row-2'),
      value: encodePersistence({ id: 'row-2', label: 'second' })
    });
    expect(secondWrites).not.toContainEqual(expect.objectContaining({ key: compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1') }));
  });

  it('does not replay a journal record already covered by its applied marker', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('ReplayCoverage');
    const record = {
      txId: 'test:1',
      runtimeEpoch: 1,
      epoch: 1,
      ops: [{ kind: 'upsert' as const, model: rows.modelId, rows: [{ id: 'row-1', label: 'persisted' }] }],
      operationTransitions: []
    };
    const journalEntry = createJournal(storage.plane, () => 'dbl:').entry(record);
    [
      { key: `dbl:applied:${rows.modelId}`, value: encodePersistence(1) },
      journalEntry
    ].forEach(entry => storage.plane.set(entry.key, entry.value));
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
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
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
    expect(storage.plane.get(compositeStorageKey('dbl:', 'tombstones', rows.modelId))).toBeUndefined();
    reader.unmount();
  });
});
