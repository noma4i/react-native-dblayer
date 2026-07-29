import { configureDb, defineModel, f } from '../../../index';
import { getApplyRuntime } from '../../../dsl/configure';
import { createCommitEnvelope } from '../../../core/apply/commitEnvelope';
import { createJournal } from '../../../core/apply/journal';
import { encodePersistence } from '../../../core/persistenceCodec';
import { bootDb } from '../../../dsl/lifecycle';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, writePersistenceManifest } from '../../../core/schemaManifest';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

describe('apply honesty (D5): mid-plan throw', () => {
  it('rejects an incomplete plan before WAL and leaves every model unchanged', () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    configureDb({ storage, transport: createMockTransport(), defaults: { onSyncError } });
    diagnostics().reset();

    const rows = defineModel({
      id: 'ApplyHonestyD5',
      name: 'ApplyHonestyD5',
      fields: { label: f.str() }
    });
    rows.insert({ id: 'row-1', label: 'baseline' });
    const journalBefore = JSON.parse(storage.get('dbl:journal:1')!) as { payload: { status: string } };
    expect(journalBefore.payload.status).toBe('committed');

    expect(() =>
      getApplyRuntime().commit(createCommitEnvelope([
        { kind: 'upsert', model: rows.modelId, rows: [{ id: 'row-2', label: 'fresh' }] },
        { kind: 'upsert', model: 'MissingApplyHonestyTarget', rows: [{ id: 'row-1', label: 'updated' }] }
      ]))
    ).toThrow('No apply target registered for MissingApplyHonestyTarget');

    expect(storage.get('dbl:journal:2')).toBeUndefined();
    expect(rows.find('row-2')).toBeUndefined();
    expect(diagnostics().snapshot().applyFailure).toBe(0);
    expect(onSyncError).not.toHaveBeenCalled();
  });
});

describe('ingest honesty (D11): failed apply is reported, not silently acknowledged', () => {
  it('isolates an onSyncError observer failure and reports it through the configured logger', () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport(),
      logger,
      defaults: {
        onSyncError: () => {
          throw new Error('observer exploded');
        }
      }
    });
    const rows = defineModel({
      id: 'IngestObserverIsolationD11',
      name: 'IngestObserverIsolationD11',
      fields: { label: f.str() }
    });
    const ingest = rows.ingest({
      remoteUpdate: {
        apply: () => {
          throw new Error('ingest apply exploded');
        }
      }
    });

    expect(() => ingest.apply('remoteUpdate', {})).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith('defineIngest onSyncError failed', { error: expect.objectContaining({ message: 'observer exploded' }) });
  });

  it('reports onSyncError, counts ingestFailed, and applies a clean redelivery of the same event', () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    configureDb({ storage, transport: createMockTransport(), defaults: { onSyncError } });
    diagnostics().reset();

    const rows = defineModel({
      id: 'IngestHonestyD11',
      name: 'IngestHonestyD11',
      fields: { label: f.str() }
    });
    rows.insert({ id: 'row-1', label: 'baseline' });

    const ingest = rows.ingest({ remoteUpdate: { apply: payload => {
      if ((payload as { label: string }).label === 'poisoned') throw new Error('ingest apply exploded');
      rows.update('row-1', payload as { label: string });
    } } });

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
  const encodedRecord = (epoch: number, model: string): string => {
    const storage = createMemoryPlane();
    return createJournal(storage, () => 'dbl:').pendingEntry({
      txId: `test:${epoch}`,
      runtimeEpoch: 1,
      epoch,
      status: 'pending',
      ops: [{ kind: 'upsert', model, rows: [{ id: `row-${epoch}`, label: 'good' }] }]
    })[0]!.value!;
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
      { key: 'dbl:journal:2', value: encodedRecord(2, 'ReplayHonestyD15') }
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
      { key: 'dbl:meta', value: encodePersistence({ lastCheckpointEpoch: 3 }) },
      { key: 'dbl:journal:3', value: JSON.stringify({ epoch: 3, status: 'committed', ops: 'not-an-array' }) }
    ]);
    writeMatchingManifest();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(storage.get('dbl:journal:3')).toBeUndefined();
    expect(diagnostics().snapshot()).toMatchObject({ corruptionJournalDrops: 1, corruptionJournalLosses: 0 });
  });
});
