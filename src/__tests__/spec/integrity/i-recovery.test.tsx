import {
  bootDb,
  compositeKey,
  computeSchemaFingerprints,
  configureDb,
  createCommitEnvelope,
  DB_FORMAT_VERSION,
  defineModelRuntime,
  encodePersistence,
  f,
  flushPersistence,
  getCommitBus,
  getApplyRuntime,
  getOperationState,
  purgeForeignStorageKeys,
  writePersistenceManifest
} from '../../testApi';
import { compositeStorageKey, createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';


const configureRecoveryRuntime = (entries: Array<{ key: string; value: string }> = []) => {
  const storage = createMemoryPlane();
  entries.forEach(entry => storage.set(entry.key, entry.value));
  configureDb({ storage, transport: createMockTransport() });
  return storage;
};

const defineRecoveryModel = (id: string) =>
  defineModelRuntime({
    id,
    name: id,
    
    fields: { bucket: f.str(), label: f.str() },
    scopes: { feed: ({ by: { bucket: 'bucket' } }) }
  });

const writeMatchingManifest = () => writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });

describe('persistence recovery protocol', () => {
  it('C1 drops one corrupt row while hydrating the remaining rows', async () => {
    const storage = configureRecoveryRuntime([
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryA', 'bad'), value: '{broken' },
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryA', 'live'), value: encodePersistence({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryA', 'kept'), value: encodePersistence({ id: 'kept', bucket: 'a', label: 'K' }) },
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryB', 'kept'), value: encodePersistence({ id: 'kept', bucket: 'b', label: 'B' }) }
    ]);
    const modelA = defineRecoveryModel('RecoveryA');
    const modelB = defineRecoveryModel('RecoveryB');
    writeMatchingManifest();
    diagnostics().reset();
    expect(storage.snapshotKeys()).toContain(compositeStorageKey('dbl:', 'row', 'RecoveryB', 'kept'));

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(modelA.find('live')).toMatchObject({ label: 'A' });
    expect(modelA.find('kept')).toMatchObject({ label: 'K' });
    expect(storage.get(compositeStorageKey('dbl:', 'row', 'RecoveryB', 'kept'))).toBe(encodePersistence({ id: 'kept', bucket: 'b', label: 'B' }));
    expect(modelB.find('kept')).toMatchObject({ label: 'B' });
    expect(storage.keys(compositeStorageKey('dbl:', 'row', 'RecoveryA')).sort()).toEqual(
      [compositeStorageKey('dbl:', 'row', 'RecoveryA', 'kept'), compositeStorageKey('dbl:', 'row', 'RecoveryA', 'live')].sort()
    );
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-row', model: modelA.modelId, count: 1 });
  });

  it('drops a row whose payload identity does not match its storage key', async () => {
    const poisonedKey = compositeStorageKey('dbl:', 'row', 'RecoveryIdentity', 'expected');
    const storage = configureRecoveryRuntime([
      { key: poisonedKey, value: encodePersistence({ id: 'foreign', bucket: 'a', label: 'Poisoned' }) },
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryIdentity', 'live'), value: encodePersistence({ id: 'live', bucket: 'a', label: 'Live' }) }
    ]);
    const model = defineRecoveryModel('RecoveryIdentity');
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.find('expected')).toBeUndefined();
    expect(model.find('foreign')).toBeUndefined();
    expect(model.find('live')).toMatchObject({ label: 'Live' });
    expect(storage.get(poisonedKey)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-row', model: model.modelId, count: 1 });
  });

  it('drops a row stored under a malformed composite identity key', async () => {
    const modelId = 'RecoveryMalformedRowKey';
    const malformedKey = `${compositeStorageKey('dbl:', 'row', modelId)}not-a-composite-key`;
    const storage = configureRecoveryRuntime([{ key: malformedKey, value: encodePersistence({ id: 'foreign', bucket: 'a', label: 'Poisoned' }) }]);
    const model = defineRecoveryModel(modelId);
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.find('foreign')).toBeUndefined();
    expect(storage.get(malformedKey)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-row', model: model.modelId, count: 1 });
  });

  it('C3 drops corrupt tombstones without discarding rows', async () => {
    const storage = configureRecoveryRuntime([
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryTombstones', 'live'), value: encodePersistence({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: compositeStorageKey('dbl:', 'tombstones', 'RecoveryTombstones'), value: '{broken' }
    ]);
    const model = defineRecoveryModel('RecoveryTombstones');
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.find('live')).toMatchObject({ label: 'A' });
    expect(storage.get(compositeStorageKey('dbl:', 'tombstones', 'RecoveryTombstones'))).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-tombstones', model: model.modelId, count: 1 });
  });

  it.each([
    ['empty tombstone id', { '': { at: 1 } }],
    ['negative tombstone time', { removed: { at: -1 } }],
    ['fractional tombstone time', { removed: { at: 1.5 } }],
    ['non-object tombstone', { removed: 1 }]
  ])('drops a semantically invalid tombstone ledger: %s', async (_label, tombstones) => {
    const modelId = `RecoveryTombstoneShape${String(_label).replaceAll(' ', '')}`;
    const tombstoneKey = compositeStorageKey('dbl:', 'tombstones', modelId);
    const storage = configureRecoveryRuntime([{ key: tombstoneKey, value: encodePersistence(tombstones) }]);
    defineRecoveryModel(modelId);
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(storage.get(tombstoneKey)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-tombstones', model: modelId, count: 1 });
  });

  it('C2 drops a corrupt scope key while retaining row and valid scope state', async () => {
    const storage = configureRecoveryRuntime([
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryScope', 'live'), value: encodePersistence({ id: 'live', bucket: 'a', label: 'A' }) },
      {
        key: compositeStorageKey('dbl:', 'scope', 'RecoveryScope', compositeKey('feed', '{"bucket":"a"}')),
        value: encodePersistence({ generation: 1, coverage: 'complete', entries: [{ id: 'live', orderKey: 'V' }] })
      },
      {
        key: compositeStorageKey('dbl:', 'scope', 'RecoveryScope', compositeKey('renamed', '{"bucket":"a"}')),
        value: encodePersistence({ generation: 1, coverage: 'complete', entries: [] })
      }
    ]);
    const model = defineRecoveryModel('RecoveryScope');
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.find('live')).toMatchObject({ label: 'A' });
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['live']);
    expect(storage.get(compositeStorageKey('dbl:', 'scope', 'RecoveryScope', compositeKey('renamed', '{"bucket":"a"}')))).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-scope', model: model.modelId, count: 1 });
  });

  it('drops a scope stored under a malformed canonical scope key', async () => {
    const modelId = 'RecoveryMalformedScopeKey';
    const malformedScopeKey = `${compositeKey('feed')}garbage`;
    const storageKey = compositeStorageKey('dbl:', 'scope', modelId, malformedScopeKey);
    const storage = configureRecoveryRuntime([{ key: storageKey, value: encodePersistence({ generation: 1, coverage: 'complete', entries: [] }) }]);
    defineRecoveryModel(modelId);
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(storage.get(storageKey)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-scope', model: modelId, count: 1 });
  });

  it.each([
    ['negative generation', { generation: -1, coverage: 'complete', entries: [] }],
    ['fractional generation', { generation: 1.5, coverage: 'complete', entries: [] }],
    ['empty member id', { generation: 1, coverage: 'complete', entries: [{ id: '', orderKey: 'V' }] }],
    ['empty order key', { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: '' }] }],
    ['invalid order alphabet', { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: 'V!' }] }],
    ['non-fractional order tail', { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: 'V0' }] }],
    [
      'duplicate member id',
      {
        generation: 1,
        coverage: 'complete',
        entries: [
          { id: 'row-1', orderKey: 'V' },
          { id: 'row-1', orderKey: 'W' }
        ]
      }
    ],
    [
      'duplicate order key',
      {
        generation: 1,
        coverage: 'complete',
        entries: [
          { id: 'row-1', orderKey: 'V' },
          { id: 'row-2', orderKey: 'V' }
        ]
      }
    ],
    [
      'non-canonical entry order',
      {
        generation: 1,
        coverage: 'complete',
        entries: [
          { id: 'row-2', orderKey: 'W' },
          { id: 'row-1', orderKey: 'V' }
        ]
      }
    ],
    ['unresolved scope with members', { generation: 0, coverage: 'delta', entries: [{ id: 'row-1', orderKey: 'V' }] }],
    ['unresolved complete scope', { generation: 0, coverage: 'complete', entries: [] }],
  ])('drops a semantically invalid scope snapshot: %s', async (_label, snapshot) => {
    const modelId = `RecoveryScopeShape${String(_label).replaceAll(' ', '')}`;
    const storageKey = compositeStorageKey('dbl:', 'scope', modelId, compositeKey('feed', '{"bucket":"a"}'));
    const storage = configureRecoveryRuntime([{ key: storageKey, value: encodePersistence(snapshot) }]);
    defineRecoveryModel(modelId);
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(storage.get(storageKey)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-scope', model: modelId, count: 1 });
  });

  it('counts only materialized members after a corrupt member row is dropped on boot', async () => {
    configureRecoveryRuntime([
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryCount', 'live'), value: encodePersistence({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: compositeStorageKey('dbl:', 'row', 'RecoveryCount', 'bad'), value: '{broken' },
      {
        key: compositeStorageKey('dbl:', 'scope', 'RecoveryCount', compositeKey('feed', '{"bucket":"a"}')),
        value: encodePersistence({
          generation: 1,
          coverage: 'complete',
          entries: [
            { id: 'live', orderKey: 'V' },
            { id: 'bad', orderKey: 'W' }
          ]
        })
      }
    ]);
    const model = defineRecoveryModel('RecoveryCount');
    writeMatchingManifest();
    await bootDb();

    const reader = renderCounted(() => model.scopes.feed.use({ bucket: 'a' }));
    const counter = renderCounted(() => model.scopes.feed.useCount({ bucket: 'a' }));
    expect(reader.result().map(row => row.id)).toEqual(['live']);
    expect(counter.result()).toBe(1);
    counter.unmount();
    reader.unmount();
  });

  it('safe-drops corrupt checkpointed WAL records', async () => {
    diagnostics().reset();
    const storage = configureRecoveryRuntime([
      { key: 'dbl:meta', value: encodePersistence({ lastCheckpointEpoch: 3 }) },
      { key: 'dbl:journal:3', value: '{broken' }
    ]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:journal:3')).toBeUndefined();
    expect(diagnostics().snapshot()).toMatchObject({ corruptionJournalDrops: 1, corruptionJournalLosses: 0 });
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'journal-corruption-checkpointed-drop', model: '__runtime__', count: 1 });
  });

  it('reports loss for corrupt WAL records newer than the checkpoint', async () => {
    diagnostics().reset();
    const storage = configureRecoveryRuntime([
      { key: 'dbl:meta', value: encodePersistence({ lastCheckpointEpoch: 2 }) },
      { key: 'dbl:journal:3', value: '{broken' }
    ]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:journal:3')).toBeUndefined();
    expect(diagnostics().snapshot()).toMatchObject({ corruptionJournalDrops: 0, corruptionJournalLosses: 1 });
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'journal-corruption-loss', model: '__runtime__', count: 1 });
  });

  it('cold-resets a corrupt operation ledger', async () => {
    const storage = configureRecoveryRuntime([{ key: 'dbl:ops', value: '{broken' }]);
    writeMatchingManifest();
    diagnostics().reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:ops')).toBeUndefined();
    expect(diagnostics().snapshot().corruptionLedgerResets).toBe(1);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'operation-ledger-corruption-reset', model: '__operations__', count: 1 });
  });

  it('rolls back a crashed request insert and closes its operation in one replay commit', async () => {
    const modelId = 'RecoveryRequestInsert';
    const tempId = 'tmp_crashed_request';
    const operationId = 'op-crashed-request';
    const storage = configureRecoveryRuntime([
      { key: compositeStorageKey('dbl:', 'row', modelId, tempId), value: encodePersistence({ id: tempId, bucket: 'a', label: 'Pending' }) },
      {
        key: 'dbl:ops',
        value: encodePersistence({
          [operationId]: {
            operationId,
            actionKey: `${modelId}:send`,
            actionMode: 'request',
            model: modelId,
            tempIds: [tempId],
            rowIds: [tempId],
            intent: 'insert',
            status: 'pending',
            input: { label: 'Pending' },
            createdAt: Date.now()
          }
        })
      }
    ]);
    const model = defineRecoveryModel(modelId);
    writeMatchingManifest();

    await bootDb();

    expect(model.find(tempId)).toBeUndefined();
    expect(getOperationState().get(operationId)?.status).toBe('rolledback');
    expect(storage.get(compositeStorageKey('dbl:', 'row', modelId, tempId))).toBeUndefined();
  });

  it('does not treat a temp row for an unregistered model as an actionable orphan', async () => {
    const key = compositeStorageKey('dbl:', 'row', 'RecoveryDeferredModel', 'temp-deferred');
    const value = encodePersistence({ id: 'temp-deferred', bucket: 'a', label: 'Deferred' });
    const storage = configureRecoveryRuntime([{ key, value }]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(storage.get(key)).toBe(value);
  });

  it('purges foreign keys and publishes ledger-only envelopes', () => {
    const storage = configureRecoveryRuntime([
      { key: 'foreign:key', value: 'foreign' },
      { key: 'dbl:owned', value: 'owned' }
    ]);
    const model = defineRecoveryModel('RecoveryMaintenanceCheckpoint');
    const events: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => events.push(batch));

    expect(purgeForeignStorageKeys()).toBe(1);
    flushPersistence();
    getApplyRuntime().commit(
      createCommitEnvelope([], [{
        kind: 'begin',
        operation: {
          operationId: 'maintenance-operation',
          actionKey: `${model.modelId}:action`,
          actionMode: 'request',
          model: model.modelId,
          tempIds: [],
          rowIds: ['row-1'],
          intent: 'patch',
          createdAt: 1
        }
      }])
    );

    expect(storage.get('foreign:key')).toBeUndefined();
    expect(storage.get('dbl:owned')).toBe('owned');
    expect(events).toContainEqual({
      mode: 'delta',
      rows: [],
      scopes: [],
      scopeChanges: [],
      pending: [{ model: model.modelId, id: 'row-1' }]
    });
    unsubscribe();
  });
});
