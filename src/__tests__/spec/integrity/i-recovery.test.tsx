import { configureDb, defineModel, f, scope } from '../../../index';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { bootDb } from '../../../dsl/lifecycle';
import { encodePersistence } from '../../../core/persistenceCodec';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

type Row = { id: string; bucket: string; label: string };

const configureRecoveryRuntime = (entries: Array<{ key: string; value: string }> = []) => {
  const storage = createMemoryPlane();
  storage.set(entries);
  configureDb({ storage, transport: createMockTransport() });
  return storage;
};

const defineRecoveryModel = (id: string) =>
  defineModel({
    id,
    name: id,
    gc: 'exempt',
    fields: { bucket: f.str(), label: f.str() },
    scopes: { feed: scope<Row>({ by: { bucket: 'bucket' } }) }
  });

const writeMatchingManifest = () => writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });

describe('persistence recovery protocol', () => {
  it('C1 drops one corrupt row while hydrating the remaining rows', async () => {
    const storage = configureRecoveryRuntime([
      { key: 'dbl:row:RecoveryA:bad', value: '{broken' },
      { key: 'dbl:row:RecoveryA:live', value: encodePersistence({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: 'dbl:row:RecoveryA:kept', value: encodePersistence({ id: 'kept', bucket: 'a', label: 'K' }) },
      { key: 'dbl:row:RecoveryB:kept', value: encodePersistence({ id: 'kept', bucket: 'b', label: 'B' }) }
    ]);
    const modelA = defineRecoveryModel('RecoveryA');
    const modelB = defineRecoveryModel('RecoveryB');
    writeMatchingManifest();
    diagnostics().reset();
    expect(storage.snapshotKeys()).toContain('dbl:row:RecoveryB:kept');

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(modelA.find('live')).toMatchObject({ label: 'A' });
    expect(modelA.find('kept')).toMatchObject({ label: 'K' });
    expect(storage.get('dbl:row:RecoveryB:kept')).toBe(encodePersistence({ id: 'kept', bucket: 'b', label: 'B' }));
    expect(modelB.find('kept')).toMatchObject({ label: 'B' });
    expect(storage.keys('dbl:row:RecoveryA:').sort()).toEqual(['dbl:row:RecoveryA:kept', 'dbl:row:RecoveryA:live']);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-row', model: modelA.modelId, count: 1 });
  });

  it('C3 drops corrupt tombstones without discarding rows', async () => {
    const storage = configureRecoveryRuntime([
      { key: 'dbl:row:RecoveryTombstones:live', value: encodePersistence({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: 'dbl:tombstones:RecoveryTombstones', value: '{broken' }
    ]);
    const model = defineRecoveryModel('RecoveryTombstones');
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.find('live')).toMatchObject({ label: 'A' });
    expect(storage.get('dbl:tombstones:RecoveryTombstones')).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-tombstones', model: model.modelId, count: 1 });
  });

  it('C2 drops a corrupt scope key while retaining row and valid scope state', async () => {
    const storage = configureRecoveryRuntime([
      { key: 'dbl:row:RecoveryScope:live', value: encodePersistence({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: 'dbl:scope:RecoveryScope:feed\0{"bucket":"a"}', value: encodePersistence({ generation: 1, coverage: 'complete', entries: [{ id: 'live', orderKey: 'V' }] }) },
      { key: 'dbl:scope:RecoveryScope:renamed:{"bucket":"a"}', value: encodePersistence({ generation: 1, coverage: 'complete', entries: [] }) }
    ]);
    const model = defineRecoveryModel('RecoveryScope');
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.find('live')).toMatchObject({ label: 'A' });
    expect(model.scopes.feed.read({ bucket: 'a' }).map(row => row.id)).toEqual(['live']);
    expect(storage.get('dbl:scope:RecoveryScope:renamed:{"bucket":"a"}')).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-scope', model: model.modelId, count: 1 });
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
});
