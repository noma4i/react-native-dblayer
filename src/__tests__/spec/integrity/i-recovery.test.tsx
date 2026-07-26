import { configureDb, defineModel, f, scope } from '../../../index';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { bootDb } from '../../../dsl/lifecycle';
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

const writeMatchingManifest = () => writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint() });

describe('persistence recovery protocol', () => {
  it('cold-resets only the model whose row snapshot is corrupt', async () => {
    const storage = configureRecoveryRuntime([
      { key: 'dbl:row:RecoveryA:bad', value: '{broken' },
      { key: 'dbl:row:RecoveryA:live', value: JSON.stringify({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: 'dbl:tombstones:RecoveryA', value: JSON.stringify({ deleted: { at: 1 } }) },
      { key: 'dbl:scope:RecoveryA:feed:{"bucket":"a"}', value: JSON.stringify({ generation: 1, coverage: 'complete', entries: [] }) },
      { key: 'dbl:applied:RecoveryA', value: '5' },
      { key: 'dbl:row:RecoveryB:kept', value: JSON.stringify({ id: 'kept', bucket: 'b', label: 'B' }) }
    ]);
    const modelA = defineRecoveryModel('RecoveryA');
    const modelB = defineRecoveryModel('RecoveryB');
    writeMatchingManifest();
    diagnostics().reset();
    expect(storage.snapshotKeys()).toContain('dbl:row:RecoveryB:kept');

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(modelA.get('live')).toBeUndefined();
    expect(storage.get('dbl:row:RecoveryB:kept')).toBe(JSON.stringify({ id: 'kept', bucket: 'b', label: 'B' }));
    expect(modelB.get('kept')).toMatchObject({ label: 'B' });
    expect(storage.keys('dbl:row:RecoveryA:')).toEqual([]);
    expect(storage.keys('dbl:scope:RecoveryA:')).toEqual([]);
    expect(storage.get('dbl:tombstones:RecoveryA')).toBeUndefined();
    expect(storage.get('dbl:applied:RecoveryA')).toBeUndefined();
    expect(diagnostics().snapshot().corruptionModelResets).toBe(1);
  });

  it('cold-resets a malformed tombstone snapshot without resurrecting model rows', async () => {
    const storage = configureRecoveryRuntime([
      { key: 'dbl:row:RecoveryTombstones:live', value: JSON.stringify({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: 'dbl:tombstones:RecoveryTombstones', value: '{broken' }
    ]);
    const model = defineRecoveryModel('RecoveryTombstones');
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.get('live')).toBeUndefined();
    expect(storage.keys('dbl:row:RecoveryTombstones:')).toEqual([]);
    expect(diagnostics().snapshot().corruptionModelResets).toBe(1);
  });

  it('treats an unknown scope name as a cold-model corruption', async () => {
    const storage = configureRecoveryRuntime([
      { key: 'dbl:row:RecoveryScope:live', value: JSON.stringify({ id: 'live', bucket: 'a', label: 'A' }) },
      { key: 'dbl:scope:RecoveryScope:renamed:{"bucket":"a"}', value: JSON.stringify({ generation: 1, coverage: 'complete', entries: [] }) }
    ]);
    const model = defineRecoveryModel('RecoveryScope');
    writeMatchingManifest();
    diagnostics().reset();

    await bootDb();

    expect(model.get('live')).toBeUndefined();
    expect(storage.keys('dbl:scope:RecoveryScope:')).toEqual([]);
    expect(diagnostics().snapshot().corruptionModelResets).toBe(1);
  });

  it('safe-drops corrupt checkpointed WAL records', async () => {
    diagnostics().reset();
    const storage = configureRecoveryRuntime([
      { key: 'dbl:meta', value: JSON.stringify({ lastCheckpointEpoch: 3 }) },
      { key: 'dbl:journal:3', value: '{broken' }
    ]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:journal:3')).toBeUndefined();
    expect(diagnostics().snapshot()).toMatchObject({ corruptionJournalDrops: 1, corruptionJournalLosses: 0 });
  });

  it('reports loss for corrupt WAL records newer than the checkpoint', async () => {
    diagnostics().reset();
    const storage = configureRecoveryRuntime([
      { key: 'dbl:meta', value: JSON.stringify({ lastCheckpointEpoch: 2 }) },
      { key: 'dbl:journal:3', value: '{broken' }
    ]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:journal:3')).toBeUndefined();
    expect(diagnostics().snapshot()).toMatchObject({ corruptionJournalDrops: 0, corruptionJournalLosses: 1 });
  });

  it('cold-resets a corrupt operation ledger', async () => {
    const storage = configureRecoveryRuntime([{ key: 'dbl:ops', value: '{broken' }]);
    writeMatchingManifest();
    diagnostics().reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:ops')).toBeUndefined();
    expect(diagnostics().snapshot().corruptionLedgerResets).toBe(1);
  });
});
