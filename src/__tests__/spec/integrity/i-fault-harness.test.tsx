import {
  bootDb,
  configureDb,
  defineModelRuntime,
  f,
  createCommitEnvelope,
  createApplyRuntime,
  createCommitBus,
  encodePersistence,
  getApplyRuntime,
  getCommitBus,
  DB_FORMAT_VERSION,
  computeSchemaFingerprints,
  resetRuntime,
  writePersistenceManifest
} from '../../testApi';
import { createFaultStorage } from '../helpers/faultStorage';
import { compositeStorageKey, createMemoryPlane, createMockTransport, diagnostics, renderCountedInProvider, settle } from '../helpers/harness';

type FaultRow = { id: string; label: string };
type FaultResponse = { detail: FaultRow };

const document = { kind: 'Document', definitions: [] } as never;

const createRows = (suffix: string) =>
  defineModelRuntime({
    id: `SpecFaultRows${suffix}`,
    name: `SpecFaultRows${suffix}`,
    fields: { label: f.str() }
  });

const createScopedRows = (suffix: string) =>
  defineModelRuntime({
    id: `SpecFaultScoped${suffix}`,
    name: `SpecFaultScoped${suffix}`,
    fields: { chatId: f.str(), label: f.str() },
    scopes: { thread: { by: { chatId: 'chatId' } } }
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

  it('[OP5] writes the ledger synchronously and the cache snapshot on the flush', () => {
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

  it('persists the commit as one atomic delta key carrying the row and its membership', () => {
    const storage = createFaultStorage();
    configureFaultRuntime(storage);
    const rows = createScopedRows('DeltaPair');

    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });

    // Kill NOW: no flush ran. The commit's only cache write is ONE delta key holding the row
    // AND its membership - the pair cannot tear because it is one physical write.
    const deltaWrites = storage.setCalls().filter(write => write.key.startsWith('dbl:delta:'));
    expect(deltaWrites).toHaveLength(1);
    const delta = JSON.parse(deltaWrites[0]!.value!) as { seq: number; ops: Array<{ kind: string }> };
    expect(delta.ops.some(op => op.kind === 'upsert')).toBe(true);
    expect(delta.ops.some(op => op.kind === 'scope' || op.kind === 'scope-delta')).toBe(true);
    expect(storage.setCalls().some(write => write.key.startsWith(`dbl:row:${rows.modelId}`))).toBe(false);
  });

  it('[P7] cuts the delta tail on corruption, wipes query records, and counts the loss', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('DeltaTailCut');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });
    rows.insert({ id: 'row-2', chatId: 'chat-1', label: 'second' });
    rows.insert({ id: 'row-3', chatId: 'chat-1', label: 'third' });

    const disk = createMemoryPlane();
    for (const write of storage.setCalls()) disk.set(write.key, write.value);
    disk.set('dbl:query:probe', 'cached-query-record');
    const deltaKeys = disk.keys('dbl:delta:').sort();
    expect(deltaKeys.length).toBeGreaterThanOrEqual(3);
    disk.set(deltaKeys[1]!, '{corrupt');

    resetRuntime();
    configureDb({ storage: disk, transport: createMockTransport() });
    await bootDb();

    // Commits before the corrupt delta live; the corrupt one and everything after are cut.
    // The cut is EXACT: the head delta stays on disk, the loss counter names the dropped count,
    // and the wipe touches only query records - never rows, snapseq, or the surviving head.
    expect(rows.find('row-1')).toMatchObject({ label: 'first' });
    expect(rows.find('row-2')).toBeUndefined();
    expect(rows.find('row-3')).toBeUndefined();
    expect(disk.get('dbl:query:probe')).toBeUndefined();
    expect(disk.keys('dbl:delta:')).toEqual([deltaKeys[0]!]);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'delta-tail-cut', model: '__runtime__', count: 2 });
  });

  it('[P24] evicts a stale-version delta tail silently as format evolution, not corruption', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('DeltaStaleVersion');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });
    rows.insert({ id: 'row-2', chatId: 'chat-1', label: 'second' });

    const disk = createMemoryPlane();
    for (const write of storage.setCalls()) disk.set(write.key, write.value);
    disk.set('dbl:query:probe', 'cached-query-record');
    const deltaKeys = disk.keys('dbl:delta:').sort();
    expect(deltaKeys.length).toBeGreaterThanOrEqual(2);
    // A future format bump: the payload is a VALID envelope of another record version.
    const foreign = JSON.parse(disk.get(deltaKeys[1]!)!) as { recordVersion: number };
    disk.set(deltaKeys[1]!, JSON.stringify({ ...foreign, recordVersion: 999 }));

    resetRuntime();
    configureDb({ storage: disk, transport: createMockTransport() });
    await bootDb();

    // Format evolution behaves like the tail-cut for STATE (tail evicted, query records wiped)
    // but is silent: no loss counter - stale version is routine evolution, not corruption.
    expect(rows.find('row-1')).toMatchObject({ label: 'first' });
    expect(rows.find('row-2')).toBeUndefined();
    expect(disk.get('dbl:query:probe')).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it.each([
    ['a string recordVersion', (delta: Record<string, unknown>) => ({ ...delta, recordVersion: '1' })],
    ['a negative seq', (delta: Record<string, unknown>) => ({ ...delta, seq: -1 })],
    ['a fractional seq', (delta: Record<string, unknown>) => ({ ...delta, seq: 1.5 })],
    ['non-array ops', (delta: Record<string, unknown>) => ({ ...delta, ops: {} })],
    ['an unknown op kind', (delta: Record<string, unknown>) => ({ ...delta, ops: [{ kind: 'garbage', model: 'X' }] })],
    ['an op without a model', (delta: Record<string, unknown>) => ({ ...delta, ops: [{ kind: 'upsert' }] })],
    ['a null op beside a valid one', (delta: Record<string, unknown>) => ({ ...delta, ops: [...(delta.ops as unknown[]), null] })]
  ])('[P28] classifies a delta carrying %s as corruption and cuts the tail', async (_name, corrupt) => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('MalformedEnvelope');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });
    rows.insert({ id: 'row-2', chatId: 'chat-1', label: 'second' });
    const disk = createMemoryPlane();
    for (const write of storage.setCalls()) disk.set(write.key, write.value);
    const deltaKeys = disk.keys('dbl:delta:').sort();
    const parsed = JSON.parse(disk.get(deltaKeys[1]!)!) as Record<string, unknown>;
    disk.set(deltaKeys[1]!, JSON.stringify(corrupt(parsed)));

    resetRuntime();
    configureDb({ storage: disk, transport: createMockTransport() });
    await bootDb();

    // Only a foreign numeric recordVersion is format evolution; every other unreadable shape is
    // corruption: the tail is cut WITH a loss counter.
    expect(rows.find('row-1')).toMatchObject({ label: 'first' });
    expect(rows.find('row-2')).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'delta-tail-cut', model: '__runtime__', count: 1 });
  });

  it('[P29] replays deltas in numeric seq order however storage enumerates keys', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('SeqOrder');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    for (let version = 0; version <= 10; version += 1) rows.insert({ id: 'row-1', chatId: 'chat-1', label: `v${version}` });
    const disk = createMemoryPlane();
    for (const write of storage.setCalls()) disk.set(write.key, write.value);
    const reversed = {
      get: (key: string) => disk.get(key),
      set: (key: string, value: string | null) => disk.set(key, value),
      keys: (prefix: string) => disk.keys(prefix).reverse()
    };

    resetRuntime();
    configureDb({ storage: reversed, transport: createMockTransport() });
    await bootDb();

    // 11 deltas force the 2-digit seq boundary: replay order comes from padded keys sorted
    // numerically, never from the plane's enumeration order.
    expect(rows.find('row-1')).toMatchObject({ label: 'v10' });
  });

  it('[P30] flush compaction writes the snapshot, advances snapseq, and deletes every covered delta', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('CompactionExact');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });
    rows.insert({ id: 'row-2', chatId: 'chat-1', label: 'second' });
    expect(storage.plane.keys('dbl:delta:').sort()).toEqual(['dbl:delta:000000000000', 'dbl:delta:000000000001']);

    getApplyRuntime().flushCacheSnapshots();

    expect(storage.plane.get(`dbl:snapseq:${rows.modelId}`)).toBe('1');
    expect(storage.plane.keys('dbl:delta:')).toEqual([]);
    expect(storage.plane.get(compositeStorageKey('dbl:', 'row', rows.modelId, 'row-2'))).toBeDefined();
  });

  it('[P31] continues the delta sequence after a reboot from compacted snapshots', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('SeqAfterFlush');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });
    getApplyRuntime().flushCacheSnapshots();
    const disk = createMemoryPlane();
    for (const write of storage.setCalls()) disk.set(write.key, write.value);
    // Numeric-looking bystander keys must not feed the seq counter.
    disk.set('app:counter', '999');
    disk.set('dbl:query:probe:99', 'cached');

    resetRuntime();
    configureDb({ storage: disk, transport: createMockTransport() });
    await bootDb();
    rows.insert({ id: 'row-2', chatId: 'chat-1', label: 'second' });

    // snapseq '0' is the only seq source left after compaction: the next delta is seq 1.
    expect(disk.keys('dbl:delta:')).toEqual(['dbl:delta:000000000001']);
  });

  it('[P31] continues the delta sequence after a reboot over live deltas', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('SeqAfterDeltas');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });
    rows.insert({ id: 'row-2', chatId: 'chat-1', label: 'second' });
    const disk = createMemoryPlane();
    for (const write of storage.setCalls()) disk.set(write.key, write.value);
    const reversed = {
      get: (key: string) => disk.get(key),
      set: (key: string, value: string | null) => disk.set(key, value),
      keys: (prefix: string) => disk.keys(prefix).reverse()
    };

    resetRuntime();
    configureDb({ storage: reversed, transport: createMockTransport() });
    await bootDb();
    expect(rows.find('row-2')).toMatchObject({ label: 'second' });
    rows.insert({ id: 'row-3', chatId: 'chat-1', label: 'third' });

    // The live delta tail (seq 0, 1) is the seq source: the next delta is seq 2, never a
    // rewrite of a live key.
    expect(disk.keys('dbl:delta:').sort()).toEqual(['dbl:delta:000000000000', 'dbl:delta:000000000001', 'dbl:delta:000000000002']);
  });

  it('[P32] skips delta ops already covered by the model snapshot and publishes nothing for them', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const rows = createScopedRows('CoveredOps');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'fresh' });
    getApplyRuntime().flushCacheSnapshots();
    const disk = createMemoryPlane();
    for (const write of storage.setCalls()) disk.set(write.key, write.value);
    // Resurrect the compacted delta with a STALE label: snapseq 0 already covers seq 0, so the
    // op must be skipped - a snapshot is never stomped by an older covered delta.
    disk.set(
      'dbl:delta:000000000000',
      JSON.stringify({ recordVersion: 1, seq: 0, ops: [{ kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', chatId: 'chat-1', label: 'stale' }] }] })
    );

    resetRuntime();
    configureDb({ storage: disk, transport: createMockTransport() });
    const batches: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => batches.push(batch));
    await bootDb();

    expect(rows.find('row-1')).toMatchObject({ label: 'fresh' });
    expect(batches).toEqual([]);
    unsubscribe();
  });

  it('[P33] reads a model snapseq from storage once per session', async () => {
    const base = createMemoryPlane();
    let snapseqReads = 0;
    const counting = {
      get: (key: string) => {
        if (key.startsWith('dbl:snapseq:')) snapseqReads += 1;
        return base.get(key);
      },
      set: base.set,
      keys: base.keys
    };
    resetRuntime();
    configureDb({ storage: counting, transport: createMockTransport() });
    const rows = createScopedRows('SnapseqReadOnce');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    rows.insert({ id: 'row-1', chatId: 'chat-1', label: 'first' });
    getApplyRuntime().flushCacheSnapshots();
    const afterFirstFlush = snapseqReads;

    rows.insert({ id: 'row-2', chatId: 'chat-1', label: 'second' });
    getApplyRuntime().flushCacheSnapshots();
    rows.insert({ id: 'row-3', chatId: 'chat-1', label: 'third' });
    getApplyRuntime().flushCacheSnapshots();

    // The in-memory snapseq cache is written on every flush: later flushes never re-read disk.
    expect(snapseqReads).toBe(afterFirstFlush);
  });

  it('[P8] converges from every kill point inside the compaction flush', async () => {
    const storage = createFaultStorage();
    resetRuntime();
    configureFaultRuntime(storage);
    const left = createScopedRows('CompactLeft');
    const right = createScopedRows('CompactRight');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    left.insert({ id: 'left-1', chatId: 'chat-1', label: 'left' });
    right.insert({ id: 'right-1', chatId: 'chat-1', label: 'right' });
    const beforeFlush = storage.setCalls().length;
    getApplyRuntime().flushCacheSnapshots();
    const writes = storage.setCalls();

    // The compaction order is snapshots -> snapseq -> delta deletion: a kill between ANY two
    // physical writes replays the still-covered deltas over whatever snapshots landed and
    // converges to the same rows and memberships.
    for (let kill = beforeFlush; kill <= writes.length; kill += 1) {
      const disk = createMemoryPlane();
      for (const write of writes.slice(0, kill)) disk.set(write.key, write.value);
      resetRuntime();
      configureDb({ storage: disk, transport: createMockTransport() });
      await bootDb();
      expect(left.find('left-1')).toMatchObject({ label: 'left' });
      expect(right.find('right-1')).toMatchObject({ label: 'right' });
      expect(left.scopes.thread.read({ chatId: 'chat-1' }).map(row => row.id)).toEqual(['left-1']);
      expect(right.scopes.thread.read({ chatId: 'chat-1' }).map(row => row.id)).toEqual(['right-1']);
    }
  });
});
