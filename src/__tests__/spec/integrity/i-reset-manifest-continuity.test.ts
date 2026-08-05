import { bootDb, computeSchemaFingerprints, configureDb, DB_FORMAT_VERSION, defineModelRuntime, encodePersistence, f, getApplyRuntime, reconcilePersistence, resetRuntime } from '../../testApi';
import type { StoragePlane } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

/**
 * Manifest continuity across a sanctioned wipe (spec 04, recovery section): a nonempty namespace of
 * a configured runtime always carries the current manifest. `resetRuntime` on logout must leave the
 * manifest behind, so same-process writes after the reset never produce an unmanifested store that
 * the next cold boot classifies as corruption.
 */

const defineRows = () => defineModelRuntime({ id: 'ResetManifestContinuityRows', name: 'ResetManifestContinuityRows', fields: { label: f.str() } });

const currentManifestPayload = () => ({ formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });

const decodedPayload = (raw: string): unknown => (JSON.parse(raw) as { payload: unknown }).payload;

const cloneDisk = (source: StoragePlane & { snapshotKeys: () => string[] }): StoragePlane & { snapshotKeys: () => string[] } => {
  const plane = createMemoryPlane();
  for (const key of source.snapshotKeys()) plane.set(key, source.get(key) ?? null);
  return plane;
};

describe('reset manifest continuity', () => {
  it('[P50] cold boot after a logout reset and same-process writes keeps the rows without corruption classification', async () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    const rows = defineRows();
    await bootDb();
    rows.insert({ id: 'pre-1', label: 'before logout' });
    getApplyRuntime().flushCacheSnapshots();

    resetRuntime();
    rows.insert({ id: 'post-1', label: 'after re-login' });
    rows.insert({ id: 'post-2', label: 'after re-login too' });
    getApplyRuntime().flushCacheSnapshots();
    expect(storage.snapshotKeys().length).toBeGreaterThan(0);

    const rebooted = cloneDisk(storage);
    resetRuntime();
    configureDb({ storage: rebooted, transport: createMockTransport() });
    const restarted = defineRows();
    diagnostics().reset();
    await bootDb();

    expect(diagnostics().snapshot().dataLossEvents.some(event => event.mechanism === 'model-corruption-recovery')).toBe(false);
    expect(diagnostics().snapshot().manifestResets).toBe(0);
    expect(restarted.find('pre-1')).toBeUndefined();
    expect(restarted.find('post-1')).toMatchObject({ label: 'after re-login' });
    expect(restarted.find('post-2')).toMatchObject({ label: 'after re-login too' });
  });

  it('[P50] resetRuntime leaves the current manifest in the wiped namespace', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    defineRows();
    storage.set('dbl:row:ResetManifestContinuityRows:stale', encodePersistence({ id: 'stale' }));

    resetRuntime();

    expect(storage.snapshotKeys()).toEqual(['dbl:manifest']);
    expect(decodedPayload(storage.get('dbl:manifest')!)).toEqual(currentManifestPayload());
  });

  it('[P50] the reset intent carries the current manifest entry for interrupted-reset replay', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    defineRows();
    let intentRaw: string | undefined;
    const set = storage.set;
    storage.set = (key, value) => {
      if (key === 'dbl:reset-intent' && value !== null) intentRaw = value;
      set(key, value);
    };

    resetRuntime();

    const intent = decodedPayload(intentRaw!) as { restore: Array<{ key: string; value: string }> };
    const manifestEntry = intent.restore.find(entry => entry.key === 'dbl:manifest');
    expect(manifestEntry).toBeDefined();
    expect(decodedPayload(manifestEntry!.value)).toEqual(currentManifestPayload());
  });

  it('[P50] a corrupt reset intent resume restores the current manifest in its replay intent', () => {
    const storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
    defineRows();
    storage.set('dbl:row:ResetManifestContinuityRows:stale', encodePersistence({ id: 'stale' }));
    storage.set('dbl:reset-intent', encodePersistence({ recordVersion: 1 }));
    let replayIntentRaw: string | undefined;
    const set = storage.set;
    storage.set = (key, value) => {
      if (key === 'dbl:reset-intent' && value !== null) replayIntentRaw = value;
      set(key, value);
    };

    expect(reconcilePersistence()).toEqual({ reset: true });

    const replayIntent = decodedPayload(replayIntentRaw!) as { restore: Array<{ key: string; value: string }> };
    expect(replayIntent.restore.some(entry => entry.key === 'dbl:manifest')).toBe(true);
    expect(storage.get('dbl:manifest')).toBeDefined();
    expect(decodedPayload(storage.get('dbl:manifest')!)).toEqual(currentManifestPayload());
  });
});
