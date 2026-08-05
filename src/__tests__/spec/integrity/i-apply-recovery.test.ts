import { bootDb, computeSchemaFingerprints, configureDb, DB_FORMAT_VERSION, defineModelRuntime, f, getApplyTarget, createCommitEnvelope, getApplyRuntime, getCommitBus, resetRuntime, writePersistenceManifest } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const createModels = () => {
  const first = defineModelRuntime({
    id: 'ApplyRecoveryFirst',
    name: 'ApplyRecoveryFirst',
    fields: { label: f.str() },
    scopes: { all: ({ sort: 'server-order' }) }
  });
  const second = defineModelRuntime({
    id: 'ApplyRecoverySecond',
    name: 'ApplyRecoverySecond',
    fields: { label: f.str() },
    scopes: { all: ({ sort: 'server-order' }) }
  });
  return { first, second };
};

describe('apply recovery', () => {
  let storage: ReturnType<typeof createMemoryPlane>;

  beforeEach(() => {
    storage = createMemoryPlane();
    configureDb({ storage, transport: createMockTransport() });
  });

  it('replays once from a clean row state and publishes only the recovered batch', () => {
    const { first, second } = createModels();
    const target = getApplyTarget(second.modelId);
    const originalPut = target.put;
    let attempts = 0;
    target.put = rows => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient row apply failure');
      return originalPut(rows);
    };
    const published: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => published.push(batch));

    try {
      expect(() =>
        getApplyRuntime().commit(
          createCommitEnvelope([
            { kind: 'upsert', model: first.modelId, rows: [{ id: 'first-row', label: 'first' }] },
            { kind: 'upsert', model: second.modelId, rows: [{ id: 'second-row', label: 'second' }] }
          ])
        )
      ).not.toThrow();

      expect(attempts).toBe(2);
      expect(first.find('first-row')).toMatchObject({ label: 'first' });
      expect(second.find('second-row')).toMatchObject({ label: 'second' });
      expect(published).toHaveLength(1);
    } finally {
      target.put = originalPut;
      unsubscribe();
    }
  });

  it('aborts scope deltas before replay so generation advances once', () => {
    const { first, second } = createModels();
    first.scopes.all.seed({}, [{ id: 'first-seed', label: 'seed' }]);
    second.scopes.all.seed({}, [{ id: 'second-seed', label: 'seed' }]);
    first.insert({ id: 'first-next', label: 'next' });
    second.insert({ id: 'second-next', label: 'next' });
    const firstTarget = getApplyTarget(first.modelId);
    const secondTarget = getApplyTarget(second.modelId);
    const firstScopeKey = firstTarget.readAllScopeKeys()[0]!;
    const secondScopeKey = secondTarget.readAllScopeKeys()[0]!;
    const initialGeneration = firstTarget.readScopeGeneration(firstScopeKey);
    const originalScopeDelta = secondTarget.scopeDelta;
    let attempts = 0;
    secondTarget.scopeDelta = (scopeKey, delta) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient scope apply failure');
      originalScopeDelta(scopeKey, delta);
    };
    const published: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => published.push(batch));

    try {
      expect(() =>
        getApplyRuntime().commit(
          createCommitEnvelope([
            {
              kind: 'scope-delta',
              model: first.modelId,
              scopeKey: firstScopeKey,
              append: [{ id: 'first-next', orderKey: 'z' }],
              detach: []
            },
            {
              kind: 'scope-delta',
              model: second.modelId,
              scopeKey: secondScopeKey,
              append: [{ id: 'second-next', orderKey: 'z' }],
              detach: []
            }
          ])
        )
      ).not.toThrow();

      expect(attempts).toBe(2);
      expect(firstTarget.readScopeGeneration(firstScopeKey)).toBe(initialGeneration + 1);
      expect(firstTarget.readScopeEntries(firstScopeKey).map(entry => entry.id)).toEqual(['first-seed', 'first-next']);
      expect(published).toHaveLength(1);
    } finally {
      secondTarget.scopeDelta = originalScopeDelta;
      unsubscribe();
    }
  });

  it('[W11] hydrates boot state through the same atomic apply without per-row publishes', async () => {
    const { first } = createModels();
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    await bootDb();
    first.insertMany([
      { id: 'row-1', label: 'one' },
      { id: 'row-2', label: 'two' },
      { id: 'row-3', label: 'three' }
    ]);
    getApplyRuntime().flushCacheSnapshots();
    const disk = createMemoryPlane();
    for (const key of storage.snapshotKeys()) disk.set(key, storage.get(key) ?? null);

    resetRuntime();
    configureDb({ storage: disk, transport: createMockTransport() });
    const batches: number[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => {
      batches.push(batch.rows.length);
    });
    await bootDb();

    // Hydration is not a separate write path: restoring rows publishes NOTHING through the
    // commit bus - the reader sees one final hydrated state, exactly like inside an apply batch.
    expect(first.find('row-1')).toMatchObject({ label: 'one' });
    expect(first.find('row-3')).toMatchObject({ label: 'three' });
    expect(batches).toEqual([]);
    unsubscribe();
  });

  it('poisons reads and publishes nothing when clean replay also fails', () => {
    const { first, second } = createModels();
    const target = getApplyTarget(second.modelId);
    const originalPut = target.put;
    target.put = () => {
      throw new Error('permanent apply failure');
    };
    const published: unknown[] = [];
    const unsubscribe = getCommitBus().subscribeAll(batch => published.push(batch));

    try {
      expect(() =>
        getApplyRuntime().commit(
          createCommitEnvelope([
            { kind: 'upsert', model: first.modelId, rows: [{ id: 'first-row', label: 'first' }] },
            { kind: 'upsert', model: second.modelId, rows: [{ id: 'second-row', label: 'second' }] }
          ])
        )
      ).toThrow('permanent apply failure');

      expect(() => first.find('first-row')).toThrow('poisoned');
      expect(published).toHaveLength(0);
    } finally {
      target.put = originalPut;
      unsubscribe();
    }
  });
});
