import { bootDb, compositeStorageKey, configureDb, createJournal, defineCommand, defineModelRuntime, defineShape, encodePersistence, f, flushPersistence, DB_FORMAT_VERSION, computeSchemaFingerprints, getOperationState, registerSchemaDeclaration, stableSerialize, writePersistenceManifest } from '../../testApi';
import type { OperationRecord, SchemaDeclaration } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const declaration = (
  id: string,
  fields: SchemaDeclaration['fields'] = { title: { kind: 'str', mode: 'required', hasDefault: false } },
  scopes: SchemaDeclaration['scopes'] = {}
): SchemaDeclaration => ({
  id,
  name: id,
  fields,
  scopes
});

const document = { kind: 'Document', definitions: [] } as never;
type OnceResult = { action: { ok: true } };
type OnceInput = { value: string };

const configureManifestRuntime = (storage = createMemoryPlane(), dataVersion?: string) => {
  configureDb({ storage, transport: createMockTransport(), dataVersion });
  return storage;
};

const modelDeclaration = (id: string): SchemaDeclaration =>
  declaration(
    id,
    { label: { kind: 'str', mode: 'required', hasDefault: false } },
    { all: { by: { label: 'label' }, sort: 'server-order' } }
  );

const defineManifestModel = (id: string, extra: Record<string, unknown> = {}) =>
  defineModelRuntime({ id, name: id, fields: { label: f.str(), ...extra }, scopes: { all: { by: { label: 'label' } } } });

const modelOperation = (operationId: string, model: string, overrides: Partial<Omit<OperationRecord, 'status'>> = {}): Omit<OperationRecord, 'status'> => ({
  operationId,
  model,
  tempIds: [],
  rowIds: [`${model}-row`],
  intent: 'patch',
  createdAt: 1,
  ...overrides
});

describe('persistence schema manifest', () => {
  it('labels every field builder and preserves default metadata through modifiers', () => {
    const shape = defineShape()({ label: f.str() });
    const fields = [f.str(), f.num(), f.int(), f.date(), f.bool(), f.id(), f.enum(['draft'] as const), f.raw(), f.custom(value => value), f.object(shape), f.array(f.str())];

    expect(fields.map(field => field.kind)).toEqual(['str', 'num', 'int', 'date', 'bool', 'id', 'enum', 'raw', 'custom', 'object', 'array']);
    expect(f.str().hasDefault).toBe(false);
    expect(f.str().nullable().hasDefault).toBe(false);
    expect(f.str().nullDefault().hasDefault).toBe(true);
    expect(f.str().default('fallback').hasDefault).toBe(true);
    expect(f.object(shape).emptyDefault().hasDefault).toBe(true);
  });

  it('computes a stable fingerprint independent of registration order', () => {
    const first = declaration('manifest-stable-first');
    const second = declaration('manifest-stable-second');

    registerSchemaDeclaration(second);
    registerSchemaDeclaration(first);
    const fingerprints = computeSchemaFingerprints();
    registerSchemaDeclaration(first);
    registerSchemaDeclaration(second);

    expect(computeSchemaFingerprints()).toEqual(fingerprints);
  });

  it('changes the fingerprint for field and scope declarations', () => {
    const id = 'manifest-sensitive';
    registerSchemaDeclaration(declaration(id));
    const baseline = computeSchemaFingerprints();

    registerSchemaDeclaration(declaration(id, { title: { kind: 'num', mode: 'required', hasDefault: false } }));
    expect(computeSchemaFingerprints()).not.toEqual(baseline);

    registerSchemaDeclaration(declaration(id, { title: { kind: 'str', mode: 'nullable', hasDefault: false } }));
    expect(computeSchemaFingerprints()).not.toEqual(baseline);

    registerSchemaDeclaration(
      declaration(id, {
        title: { kind: 'str', mode: 'required', hasDefault: false },
        subtitle: { kind: 'str', mode: 'required', hasDefault: false }
      })
    );
    expect(computeSchemaFingerprints()).not.toEqual(baseline);

    registerSchemaDeclaration(declaration(id));
    expect(computeSchemaFingerprints()).toEqual(baseline);

    registerSchemaDeclaration(declaration(id, undefined, { feed: { by: { ownerId: 'ownerId' }, sort: 'server-order' } }));
    const scoped = computeSchemaFingerprints();
    expect(scoped).not.toEqual(baseline);

    registerSchemaDeclaration(declaration(id, undefined, { feed: { by: { ownerId: 'authorId' }, sort: 'field:createdAt:desc' } }));
    expect(computeSchemaFingerprints()).not.toEqual(scoped);
  });

  it('writes a manifest for an empty boot without resetting', async () => {
    const storage = configureManifestRuntime();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect((JSON.parse(storage.get('dbl:manifest')!) as { payload: unknown }).payload).toEqual({
      formatVersion: DB_FORMAT_VERSION,
      schemaFingerprints: computeSchemaFingerprints(),
      dataVersion: null
    });
  });

  it('preserves existing data when the manifest matches', async () => {
    const storage = configureManifestRuntime();

    await bootDb();
    storage.set([{ key: 'dbl:sentinel', value: 'kept' }]);

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:sentinel')).toBe('kept');
  });

  it('cold-resets persisted data when the consumer data version changes', async () => {
    const storage = configureManifestRuntime(undefined, 'build-1');
    await bootDb();
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { manifestResets: number; dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    configureManifestRuntime(storage, 'build-2');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
    expect((JSON.parse(storage.get('dbl:manifest')!) as { payload: unknown }).payload).toEqual({
      formatVersion: DB_FORMAT_VERSION,
      schemaFingerprints: computeSchemaFingerprints(),
      dataVersion: 'build-2'
    });
    expect(diagnostics.snapshot().manifestResets).toBe(1);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'data-version-migration-reset', model: '__runtime__', count: 1 });
  });

  it('retains a committed once key across a consumer data version migration', async () => {
    const storage = createMemoryPlane();
    const transport = createMockTransport({ mutation: async <TData,>() => ({ data: { action: { ok: true } } as TData }) });
    configureDb({ storage, transport, dataVersion: 'build-1' });
    await bootDb();
    const first = defineCommand<OnceResult, OnceInput>('ManifestOnceMigration', { document, result: 'action', once: true });
    await first.run({ value: 'once' });

    configureDb({ storage, transport, dataVersion: 'build-2' });
    const restarted = defineCommand<OnceResult, OnceInput>('ManifestOnceMigration', { document, result: 'action', once: true });
    await bootDb();

    expect(storage.get('dbl:ops')).toBeUndefined();
    expect(await restarted.run({ value: 'once' })).toBeNull();
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
  });

  it('does not classify a consumer data version migration as corruption recovery', async () => {
    const storage = configureManifestRuntime(undefined, 'build-1');
    await bootDb();
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    configureManifestRuntime(storage, 'build-2');
    await bootDb();

    expect(diagnostics.snapshot().dataLossEvents.some(event => event.mechanism === 'model-corruption-recovery')).toBe(false);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'data-version-migration-reset', model: '__runtime__', count: 1 });
  });

  it('does not classify a schema and consumer data version migration as corruption recovery', async () => {
    const storage = configureManifestRuntime(undefined, 'build-1');
    const id = 'manifest-version-and-schema';
    registerSchemaDeclaration(declaration(id));
    await bootDb();
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    registerSchemaDeclaration(declaration(id, { title: { kind: 'num', mode: 'required', hasDefault: false } }));
    configureManifestRuntime(storage, 'build-2');
    await bootDb();

    expect(diagnostics.snapshot().dataLossEvents.some(event => event.mechanism === 'model-corruption-recovery')).toBe(false);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'data-version-migration-reset', model: '__runtime__', count: 1 });
  });

  it('preserves persisted data when the consumer data version matches', async () => {
    const storage = configureManifestRuntime(undefined, 'build-1');
    await bootDb();
    storage.set([{ key: 'dbl:sentinel', value: 'kept' }]);

    configureManifestRuntime(storage, 'build-1');

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:sentinel')).toBe('kept');
  });

  it('cold-resets persisted data when the consumer changes from the default version to a build version', async () => {
    const storage = configureManifestRuntime();
    await bootDb();
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);

    configureManifestRuntime(storage, 'build-1');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('preserves persisted data across boots when the consumer omits the data version', async () => {
    const storage = configureManifestRuntime();
    await bootDb();
    storage.set([{ key: 'dbl:sentinel', value: 'kept' }]);

    configureManifestRuntime(storage);

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:sentinel')).toBe('kept');
  });

  it('converts a format 7 fingerprint without losing either model', async () => {
    const storage = configureManifestRuntime();
    const alphaId = 'ManifestLegacyA,';
    const betaId = 'ManifestLegacyA';
    const alphaBefore = defineManifestModel(alphaId);
    const betaBefore = defineManifestModel(betaId);
    await bootDb();
    alphaBefore.insert({ id: 'alpha-1', label: 'alpha' });
    betaBefore.insert({ id: 'beta-1', label: 'beta' });
    flushPersistence();
    writePersistenceManifest('dbl:', { formatVersion: 7, schemaFingerprint: stableSerialize([modelDeclaration(alphaId), modelDeclaration(betaId)]), dataVersion: null });

    configureManifestRuntime(storage);
    const alphaAfter = defineManifestModel(alphaId);
    const betaAfter = defineManifestModel(betaId);
    const currentFingerprints = computeSchemaFingerprints();
    const boot = await bootDb();
    const manifest = JSON.parse(storage.get('dbl:manifest')!) as { payload: { formatVersion: number; schemaFingerprints: Record<string, string> } };

    expect(boot.reset).toBe(false);
    expect(alphaAfter.find('alpha-1')).toMatchObject({ id: 'alpha-1', label: 'alpha' });
    expect(betaAfter.find('beta-1')).toMatchObject({ id: 'beta-1', label: 'beta' });
    expect(manifest.payload.formatVersion).toBe(DB_FORMAT_VERSION);
    expect(manifest.payload.schemaFingerprints).toEqual(currentFingerprints);
    expect(Object.keys(manifest.payload.schemaFingerprints)).toEqual(Object.keys(currentFingerprints));
  });

  it('clears only the changed model for a legacy fingerprint mismatch', async () => {
    const storage = configureManifestRuntime();
    const alphaId = 'ManifestBlastAlpha';
    const betaId = 'ManifestBlastBeta';
    const alphaDeclaration = declaration(alphaId, { label: { kind: 'str', mode: 'required', hasDefault: false } }, { all: { by: { label: 'label' }, sort: 'server-order' } });
    const betaDeclaration = declaration(betaId, { label: { kind: 'str', mode: 'required', hasDefault: false } }, { all: { by: { label: 'label' }, sort: 'server-order' } });
    const defineAlpha = (extra: Record<string, unknown>) =>
      defineModelRuntime({ id: alphaId, name: alphaId, fields: { label: f.str(), ...extra }, scopes: { all: { by: { label: 'label' } } } });
    const defineBeta = () => defineModelRuntime({ id: betaId, name: betaId, fields: { label: f.str() }, scopes: { all: { by: { label: 'label' } } } });
    const alphaBefore = defineAlpha({});
    const betaBefore = defineBeta();
    await bootDb();
    alphaBefore.insert({ id: 'alpha-1', label: 'alpha' });
    betaBefore.insert({ id: 'beta-1', label: 'beta' });
    flushPersistence();
    const alphaScopePrefix = compositeStorageKey('dbl:', 'scope', alphaId);
    expect(storage.keys(alphaScopePrefix).length).toBeGreaterThan(0);
    storage.set([
      { key: compositeStorageKey('dbl:', 'scope', alphaId, 'manual'), value: 'scope' },
      { key: compositeStorageKey('dbl:', 'tombstones', alphaId), value: encodePersistence({ 'alpha-stale': { at: 1 } }) },
      { key: 'dbl:query:keep', value: 'query' }
    ]);
    const legacyFingerprint = stableSerialize([betaDeclaration, alphaDeclaration]);
    writePersistenceManifest('dbl:', { formatVersion: 7, schemaFingerprint: legacyFingerprint, dataVersion: null });

    configureManifestRuntime(storage);
    const alphaAfter = defineAlpha({ added: f.str().nullDefault() });
    const betaAfter = defineBeta();
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { manifestResets: number; dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(alphaAfter.find('alpha-1')).toBeUndefined();
    expect(betaAfter.find('beta-1')).toMatchObject({ id: 'beta-1', label: 'beta' });
    expect(storage.keys(alphaScopePrefix)).toEqual([]);
    expect(storage.get(compositeStorageKey('dbl:', 'scope', alphaId, 'manual'))).toBeUndefined();
    expect(storage.get(compositeStorageKey('dbl:', 'tombstones', alphaId))).toBeUndefined();
    expect(storage.get('dbl:query:keep')).toBe('query');
    expect(diagnostics.snapshot().manifestResets).toBe(0);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'schema-migration-reset', model: alphaId, count: 1 });

    const firstDataLossEvents = diagnostics.snapshot().dataLossEvents;
    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(diagnostics.snapshot().dataLossEvents).toEqual(firstDataLossEvents);
  });

  it('discards changed-model operation records while preserving sibling records and once keys', async () => {
    const storage = configureManifestRuntime();
    const alphaId = 'ManifestLedgerAlpha';
    const betaId = 'ManifestLedgerBeta';
    defineManifestModel(alphaId);
    defineManifestModel(betaId);
    await bootDb();
    const ledger = getOperationState();
    ledger.begin(modelOperation('alpha-operation', alphaId));
    ledger.begin(modelOperation('beta-operation', betaId));
    ledger.begin(modelOperation('beta-once-operation', betaId, { idempotencyKey: 'beta-once-key', once: true }));
    ledger.close('beta-once-operation', 'committed');
    writePersistenceManifest('dbl:', { formatVersion: 7, schemaFingerprint: stableSerialize([modelDeclaration(alphaId), modelDeclaration(betaId)]), dataVersion: null });

    configureManifestRuntime(storage);
    defineManifestModel(alphaId, { added: f.str().nullDefault() });
    defineManifestModel(betaId);
    await bootDb();

    const restartedLedger = getOperationState();
    expect(restartedLedger.get('alpha-operation')).toBeUndefined();
    expect(restartedLedger.get('beta-operation')).toBeDefined();
    expect(restartedLedger.get('beta-once-operation')).toBeDefined();
    expect(restartedLedger.hasCommitted('beta-once-key')).toBe(true);
    const operations = JSON.parse(storage.get('dbl:ops')!) as { payload: Record<string, OperationRecord> };
    expect(operations.payload).not.toHaveProperty('alpha-operation');
    expect(operations.payload).toHaveProperty('beta-operation');
    expect(storage.get('dbl:ops-once')).toBeDefined();
    expect(restartedLedger.discardModels(new Set([betaId]))).toBe(2);
  });

  it('does not replay a changed model from a mixed WAL and replays its sibling', async () => {
    const storage = configureManifestRuntime();
    const alphaId = 'ManifestWalAlpha';
    const betaId = 'ManifestWalBeta';
    defineManifestModel(alphaId);
    defineManifestModel(betaId);
    writePersistenceManifest('dbl:', { formatVersion: 7, schemaFingerprint: stableSerialize([modelDeclaration(alphaId), modelDeclaration(betaId)]), dataVersion: null });
    const journal = createJournal(storage, () => 'dbl:');
    storage.set(
      journal.pendingEntry({
        txId: 'manifest-wal',
        runtimeEpoch: 1,
        epoch: 1,
        status: 'pending',
        ops: [
          { kind: 'upsert', model: alphaId, rows: [{ id: 'alpha-wal', label: 'alpha' }] },
          { kind: 'upsert', model: betaId, rows: [{ id: 'beta-wal', label: 'beta' }] }
        ]
      })
    );

    configureManifestRuntime(storage);
    const alpha = defineManifestModel(alphaId, { added: f.str().nullDefault() });
    const beta = defineManifestModel(betaId);
    const boot = await bootDb();

    expect(boot).toMatchObject({ replayed: 1, reset: false });
    expect(alpha.find('alpha-wal')).toBeUndefined();
    expect(beta.find('beta-wal')).toMatchObject({ id: 'beta-wal', label: 'beta' });
    expect(storage.get(`dbl:applied:${alphaId}`)).toBe(encodePersistence(1));
  });

  it('cold-resets format 4 keys before reading the injective composite-key format', async () => {
    const storage = configureManifestRuntime();
    writePersistenceManifest('dbl:', { formatVersion: 4, schemaFingerprint: stableSerialize([declaration('manifest-format-4')]), dataVersion: null });
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('cold-resets format 5 keys from the membership-edge era', async () => {
    const storage = configureManifestRuntime();
    writePersistenceManifest('dbl:', { formatVersion: 5, schemaFingerprint: stableSerialize([declaration('manifest-format-5')]), dataVersion: null });
    storage.set([{ key: 'dbl:sentinel', value: 'edge-era' }]);

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('records manifest-driven resets in diagnostics', async () => {
    const storage = configureManifestRuntime();
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);
    writePersistenceManifest('dbl:', { formatVersion: 6, schemaFingerprint: 'outdated', dataVersion: null });
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { manifestResets: number; dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(diagnostics.snapshot().manifestResets).toBe(1);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'data-version-migration-reset', model: '__runtime__', count: 1 });
  });

  it('cold-resets a valid manifest with an unsupported format', async () => {
    const storage = configureManifestRuntime();
    defineManifestModel('ManifestUnsupportedFormat');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION + 1, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('resets nonempty storage without a manifest', async () => {
    const storage = configureManifestRuntime();
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'model-corruption-recovery', model: '__runtime__', count: 1 });
  });

  it('treats malformed manifests as absent when storage is nonempty', async () => {
    const storage = configureManifestRuntime();
    storage.set([
      { key: 'dbl:manifest', value: '{broken' },
      { key: 'dbl:sentinel', value: 'discard' }
    ]);

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
    expect(storage.snapshotKeys()).toEqual(['dbl:manifest']);
  });
});

describe('manifest shape guard', () => {
  it('treats every malformed persisted manifest as corruption and cold-resets a nonempty store', async () => {
    const malformed = [
      '{not-json',
      JSON.stringify(42),
      JSON.stringify({ formatVersion: '2', schemaFingerprint: 'fp', dataVersion: null }),
      JSON.stringify({ formatVersion: DB_FORMAT_VERSION, schemaFingerprint: 7, dataVersion: null }),
      JSON.stringify({ formatVersion: DB_FORMAT_VERSION, schemaFingerprint: 'fp', dataVersion: 7 })
    ];
    for (const value of malformed) {
      const storage = configureManifestRuntime();
      storage.set([
        { key: 'dbl:manifest', value },
        { key: 'dbl:sentinel', value: 'stale' }
      ]);

      await expect(bootDb()).resolves.toMatchObject({ reset: true });
      expect(storage.get('dbl:sentinel')).toBeUndefined();
    }
  });

  it('rejects malformed current maps and malformed format 7 arrays', async () => {
    const malformedPayloads: Array<{ payload: Record<string, unknown>; mechanism: 'model-corruption-recovery' }> = [
      { payload: { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: [], dataVersion: null }, mechanism: 'model-corruption-recovery' },
      { payload: { formatVersion: '8', schemaFingerprints: {}, dataVersion: null }, mechanism: 'model-corruption-recovery' },
      { payload: { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: {}, dataVersion: 7 }, mechanism: 'model-corruption-recovery' },
      { payload: { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: { '': 'fingerprint' }, dataVersion: null }, mechanism: 'model-corruption-recovery' },
      { payload: { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: { Alpha: 7 }, dataVersion: null }, mechanism: 'model-corruption-recovery' },
      { payload: { formatVersion: 7, schemaFingerprint: JSON.stringify([{ id: 'duplicate' }, { id: 'duplicate' }]), dataVersion: null }, mechanism: 'model-corruption-recovery' },
      { payload: { formatVersion: 7, schemaFingerprint: JSON.stringify([{ id: '' }]), dataVersion: null }, mechanism: 'model-corruption-recovery' },
      { payload: { formatVersion: 7, schemaFingerprint: JSON.stringify({ id: 'not-an-array' }), dataVersion: null }, mechanism: 'model-corruption-recovery' }
    ];

    for (const { payload, mechanism } of malformedPayloads) {
      const storage = configureManifestRuntime();
      const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
        reset: () => void;
        snapshot: () => { dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
      };
      storage.set([
        { key: 'dbl:manifest', value: encodePersistence(payload) },
        { key: 'dbl:sentinel', value: 'stale' }
      ]);
      diagnostics.reset();

      await expect(bootDb()).resolves.toMatchObject({ reset: true });
      expect(storage.get('dbl:sentinel')).toBeUndefined();
      expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism, model: '__runtime__', count: 1 });
    }
  });

  it('orders schema migration loss events by model id', async () => {
    const storage = configureManifestRuntime();
    const firstId = 'ManifestOrderB';
    const secondId = 'ManifestOrderA';
    defineManifestModel(firstId);
    defineManifestModel(secondId);
    await bootDb();

    writePersistenceManifest('dbl:', {
      formatVersion: DB_FORMAT_VERSION,
      schemaFingerprints: { [firstId]: 'old-first', [secondId]: 'old-second' },
      dataVersion: null
    });
    configureManifestRuntime(storage);
    defineManifestModel(firstId);
    defineManifestModel(secondId);
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(diagnostics.snapshot().dataLossEvents).toEqual([
      { mechanism: 'schema-migration-reset', model: secondId, count: 1 },
      { mechanism: 'schema-migration-reset', model: firstId, count: 1 }
    ]);
  });
});
