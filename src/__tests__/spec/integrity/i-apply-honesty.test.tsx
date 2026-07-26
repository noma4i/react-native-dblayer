import { configureDb, defineModel, f } from '../../../index';
import { getApplyRuntime } from '../../../dsl/configure';
import { bootDb } from '../../../dsl/lifecycle';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

describe('apply honesty (D5): mid-plan throw', () => {
  it('rethrows, leaves the epoch journal record pending, reports onSyncError, and counts applyFailure', () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    configureDb({ storage, transport: createMockTransport(), defaults: { onSyncError } });
    diagnostics().reset();

    const rows = defineModel({
      id: 'ApplyHonestyD5',
      name: 'ApplyHonestyD5',
      fields: { label: f.str() },
      write: {
        groups: [
          {
            fields: ['label'] as const,
            policy: {
              merge: () => {
                throw new Error('write-group merge exploded');
              }
            }
          }
        ]
      }
    });
    rows.insert({ id: 'row-1', label: 'baseline' });
    const journalBefore = JSON.parse(storage.get('dbl:journal:1')!) as { status: string };
    expect(journalBefore.status).toBe('committed');

    expect(() =>
      getApplyRuntime().apply([
        { kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-2', label: 'fresh' }] },
        { kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-1', label: 'updated' }] }
      ])
    ).toThrow('write-group merge exploded');

    const journalAfter = storage.get('dbl:journal:2');
    expect(journalAfter).toBeDefined();
    expect(JSON.parse(journalAfter!)).toMatchObject({ status: 'pending' });
    expect(diagnostics().snapshot().applyFailure).toBe(1);
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), { source: 'apply' });
    expect(onSyncError.mock.calls[0]![0]).toMatchObject({ message: 'write-group merge exploded' });
  });
});

describe('ingest honesty (D11): failed apply is reported, not silently acknowledged', () => {
  it('reports onSyncError, counts ingestFailed, and applies a clean redelivery of the same event', () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    configureDb({ storage, transport: createMockTransport(), defaults: { onSyncError } });
    diagnostics().reset();

    const rows = defineModel({
      id: 'IngestHonestyD11',
      name: 'IngestHonestyD11',
      fields: { label: f.str() },
      write: {
        groups: [
          {
            fields: ['label'] as const,
            policy: {
              merge: (_current, incoming) => {
                if (incoming === 'poisoned') throw new Error('ingest merge exploded');
                return incoming;
              }
            }
          }
        ]
      }
    });
    rows.insert({ id: 'row-1', label: 'baseline' });

    const ingest = rows.ingest({ remoteUpdate: { apply: payload => rows.update('row-1', payload as { label: string }) } });

    ingest.apply('remoteUpdate', { label: 'poisoned' });

    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), { source: 'ingest', model: rows.modelId, event: 'remoteUpdate' });
    expect(diagnostics().snapshot().ingestFailed).toBe(1);
    expect(rows.find('row-1')?.label).toBe('baseline');

    ingest.apply('remoteUpdate', { label: 'accepted' });

    expect(rows.find('row-1')?.label).toBe('accepted');
    expect(diagnostics().snapshot().ingestFailed).toBe(1);
  });
});

describe('replay honesty (D15): parseable-but-malformed WAL records', () => {
  const configureBootRuntime = (entries: Array<{ key: string; value: string }>) => {
    const storage = createMemoryPlane();
    storage.set(entries);
    configureDb({ storage, transport: createMockTransport() });
    return storage;
  };
  const writeMatchingManifest = () => writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });

  it('routes an ops-not-array record through the corruption drop path instead of throwing on boot', async () => {
    // `createApplyRuntime` reads `journal.lastEpoch()` eagerly at construction (inside `configureDb`), so the
    // corrupt-record classification already fires there - reset diagnostics before configuring, not after.
    diagnostics().reset();
    const storage = configureBootRuntime([{ key: 'dbl:journal:1', value: JSON.stringify({ epoch: 1, status: 'pending', ops: {} }) }]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(storage.get('dbl:journal:1')).toBeUndefined();
    expect(diagnostics().snapshot().corruptionJournalLosses).toBe(1);
  });

  it('routes an op missing kind/model through the corruption drop path and still replays the sibling record', async () => {
    diagnostics().reset();
    const storage = configureBootRuntime([
      { key: 'dbl:journal:1', value: JSON.stringify({ epoch: 1, status: 'pending', ops: [{ rows: [{ id: 'row-1' }] }] }) },
      { key: 'dbl:journal:2', value: JSON.stringify({ epoch: 2, status: 'pending', ops: [{ kind: 'upsert', model: 'ReplayHonestyD15', rows: [{ id: 'row-2', label: 'good' }] }] }) }
    ]);
    const rows = defineModel({ id: 'ReplayHonestyD15', name: 'ReplayHonestyD15', gc: 'exempt', fields: { label: f.str() } });
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(storage.get('dbl:journal:1')).toBeUndefined();
    expect(diagnostics().snapshot().corruptionJournalLosses).toBe(1);
    expect(rows.find('row-2')).toMatchObject({ label: 'good' });
  });

  it('safe-drops a checkpointed malformed-shape record the same way as checkpointed parse-corrupt JSON', async () => {
    diagnostics().reset();
    const storage = configureBootRuntime([
      { key: 'dbl:meta', value: JSON.stringify({ lastCheckpointEpoch: 3 }) },
      { key: 'dbl:journal:3', value: JSON.stringify({ epoch: 3, status: 'committed', ops: 'not-an-array' }) }
    ]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(storage.get('dbl:journal:3')).toBeUndefined();
    expect(diagnostics().snapshot()).toMatchObject({ corruptionJournalDrops: 1, corruptionJournalLosses: 0 });
  });
});
