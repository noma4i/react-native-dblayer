import {
  configureDb,
  defineModelRuntime,
  f,
  createCommitEnvelope,
  createApplyRuntime,
  createCommitBus,
  encodePersistence,
  getApplyRuntime,
  DB_FORMAT_VERSION,
  computeSchemaFingerprints,
  writePersistenceManifest
} from '../../testApi';
import { createFaultStorage } from '../helpers/faultStorage';
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
  configureDb({ storage: storage.plane, transport: createMockTransport() });
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

      // Tombstones decay by TTL on the model's next persisted flush.
      rows.insert({ id: 'row-2', label: 'touch' });
      getApplyRuntime().flushCacheSnapshots();

      expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'tombstone-expiry', model: rows.modelId, count: 1 });
    } finally {
      clock.mockRestore();
    }
  });

  it('lands the row entry on the coalescing flush after the insert', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('ImmediateWrite');

    rows.insert({ id: 'row-1', label: 'local' });
    getApplyRuntime().flushCacheSnapshots();

    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1'))).toBe(encodePersistence({ id: 'row-1', label: 'local' }));
  });

  it('writes the ledger synchronously and the cache snapshot on the flush', () => {
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

    // The ledger write is synchronous with the commit; the cache snapshot lands on the flush.
    expect(storage.setCalls().map(write => write.key)).toContain('dbl:ops');
    runtime.flushCacheSnapshots();
    const keys = storage.setCalls().map(write => write.key);
    expect(keys).toContain(compositeStorageKey('dbl:', 'row', rows.modelId, 'temp-1'));
    expect(JSON.parse(storage.plane.get('dbl:ops')!) as { payload: unknown }).toMatchObject({
      payload: { operations: { 'operation-1': expect.objectContaining({ operationId: 'operation-1' }) } }
    });
  });

  it('keeps a refused cache snapshot dirty and retries it on the next flush', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('FailedWrite');

    rows.insert({ id: 'row-1', label: 'local' });
    storage.failNextSet();
    expect(() => getApplyRuntime().flushCacheSnapshots()).toThrow('fault: set failed');

    // The refused model stayed dirty: the retry lands the same snapshot.
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1'))).toBe(encodePersistence({ id: 'row-1', label: 'local' }));
  });

  it('acknowledges immediate persistence before the next direct transaction', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createRows('ImmediateAck');
    const runtime = createApplyRuntime({ storage: storage.plane, prefix: () => 'dbl:', bus: createCommitBus() });

    runtime.commit(createCommitEnvelope([{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', label: 'first' }] }]));
    runtime.flushCacheSnapshots();
    const firstCommitWrites = storage.setCalls().length;
    runtime.commit(createCommitEnvelope([{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-2', label: 'second' }] }]));
    runtime.flushCacheSnapshots();

    const secondWrites = storage.setCalls().slice(firstCommitWrites);
    expect(secondWrites).toContainEqual({
      key: compositeStorageKey('dbl:', 'row', rows.modelId, 'row-2'),
      value: encodePersistence({ id: 'row-2', label: 'second' })
    });
    expect(secondWrites).not.toContainEqual(expect.objectContaining({ key: compositeStorageKey('dbl:', 'row', rows.modelId, 'row-1') }));
  });

  it('rejects a server snapshot after destroy but lets an event-origin insert restore the row', async () => {
    const storage = createFaultStorage();
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { detail: { id: 'row-1', label: 'server' } } as TData }) });
    configureDb({ storage: storage.plane, transport });
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
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.plane.get(compositeStorageKey('dbl:', 'tombstones', rows.modelId))).toBeUndefined();
    reader.unmount();
  });
});
