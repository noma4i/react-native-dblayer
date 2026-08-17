import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { bootDb, compositeKey, compositeStorageKey, configureDb, defineModel, defineModelRuntime, defineShape, encodePersistence, f, DB_FORMAT_VERSION, computeSchemaFingerprints, getApplyRuntime, getOperationState, registerSchemaDeclaration, stableSerialize, writePersistenceManifest } from '../../testApi';
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

type OnceResult = { action: { ok: true } };
type OnceInput = { value: string };
type OnceRow = { id: string; value: string };
const onceDocument: TypedDocumentNode<OnceResult, OnceInput> = { kind: Kind.DOCUMENT, definitions: [] };
const OnceSchema = defineShape<OnceRow>()({ value: f.str() });

const defineOnceAction = () => {
  const model = defineModel('ManifestOnceMigration', {
    schema: OnceSchema,
    actions: owner => ({
      run: owner.gql.action(onceDocument, {
        mode: 'request',
        result: 'action',
        variables: (input: OnceInput) => input,
        dedupe: { key: input => compositeKey('ManifestOnceMigration', stableSerialize(input)) },
        once: true,
        root: { insert: { select: () => null } }
      })
    })
  });
  return model.actions.run;
};

const configureManifestRuntime = (storage = createMemoryPlane(), dataVersion?: string) => {
  configureDb({ storage, transport: createMockTransport(), dataVersion });
  return storage;
};

const defineManifestModel = (id: string, extra: Record<string, unknown> = {}) =>
  defineModelRuntime({ id, name: id, fields: { label: f.str(), ...extra }, scopes: { all: { by: { label: 'label' } } } });

const modelOperation = (operationId: string, model: string, overrides: Partial<Omit<OperationRecord, 'status'>> = {}): Omit<OperationRecord, 'status'> => ({
  operationId,
  actionKey: `${model}:action`,
  actionMode: 'request',
  model,
  tempIds: [],
  rowIds: [`${model}-row`],
  intent: 'patch',
  createdAt: 1,
  ...overrides
});

describe('persistence schema manifest', () => {
  it('applies every declared field kind and its default to the row a reader gets', async () => {
    configureManifestRuntime();
    const inner = defineShape()({ label: f.str() });
    const rows = defineModelRuntime({
      id: 'ManifestFieldKinds',
      name: 'ManifestFieldKinds',
      fields: {
        text: f.str(),
        amount: f.num(),
        count: f.int(),
        at: f.date(),
        flag: f.bool(),
        ref: f.id(),
        state: f.enum(['draft', 'sent'] as const),
        payload: f.raw(),
        // A custom field reads the whole row, so its value follows the fields it derives from.
        computed: f.custom((row: { amount?: number } | null | undefined) => `computed-${row?.amount ?? 0}`),
        nested: f.object(inner).nullDefault(),
        tags: f.array(f.str()),
        fallback: f.str().default('fallback'),
        optional: f.str().nullDefault()
      }
    });
    await bootDb();

    rows.insert({
      id: 'row-1',
      text: 'text',
      amount: 1.5,
      count: 2,
      at: '2026-08-05T00:00:00Z',
      flag: true,
      ref: 'ref-1',
      state: 'draft',
      payload: { any: 'thing' },
      tags: ['a', 'b']
    } as never);

    // Declared kinds and declared defaults are what the reader gets: an omitted field with a
    // declared default carries that default, and a declared kind normalizes its value.
    expect(rows.find('row-1')).toMatchObject({
      id: 'row-1',
      text: 'text',
      amount: 1.5,
      count: 2,
      flag: true,
      ref: 'ref-1',
      state: 'draft',
      payload: { any: 'thing' },
      computed: 'computed-1.5',
      tags: ['a', 'b'],
      optional: null,
      nested: null
    });
  });

  it('keeps stored rows when only the declaration ORDER changes and drops them when a field declaration changes', async () => {
    const storage = createMemoryPlane();
    const boot = async (fields: Record<string, unknown>, order: 'ab' | 'ba') => {
      configureDb({ storage, transport: createMockTransport() });
      const first = defineModelRuntime({ id: 'ManifestOrderFirst', name: 'ManifestOrderFirst', fields: { label: f.str() } });
      const second = defineModelRuntime({ id: 'ManifestOrderSecond', name: 'ManifestOrderSecond', fields: fields as { label: ReturnType<typeof f.str> } });
      const result = await bootDb();
      return { first, second, result, models: order === 'ab' ? [first, second] : [second, first] };
    };

    const initial = await boot({ label: f.str() }, 'ab');
    initial.first.insert({ id: 'row-1', label: 'kept' });
    initial.second.insert({ id: 'row-2', label: 'kept-too' });

    // Same declarations, registered in the other order: the fingerprint is the same, so nothing resets.
    const reordered = await boot({ label: f.str() }, 'ba');
    expect(reordered.result.reset).toBe(false);
    expect(reordered.first.all().map(row => row.id)).toEqual(['row-1']);
    expect(reordered.second.all().map(row => row.id)).toEqual(['row-2']);

    // A changed field declaration of ONE model drops that model's rows and keeps the other's.
    const changed = await boot({ label: f.num() }, 'ab');
    expect(changed.first.all().map(row => row.id)).toEqual(['row-1']);
    expect(changed.second.all()).toEqual([]);
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
    storage.set('dbl:sentinel', 'kept');

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:sentinel')).toBe('kept');
  });

  it('cold-resets persisted data when the consumer data version changes', async () => {
    const storage = configureManifestRuntime(undefined, 'build-1');
    await bootDb();
    storage.set('dbl:sentinel', 'discard');
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
    const first = defineOnceAction();
    await first.run({ value: 'once' });

    configureDb({ storage, transport, dataVersion: 'build-2' });
    const restarted = defineOnceAction();
    await bootDb();

    expect(storage.get('dbl:ops')).toBeDefined();
    expect(await restarted.run({ value: 'once' })).toBeNull();
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
  });

  it('does not classify a consumer data version migration as corruption recovery', async () => {
    const storage = configureManifestRuntime(undefined, 'build-1');
    const rows = defineManifestModel('ManifestVersionRows');
    await bootDb();
    rows.insert({ id: 'row-1', label: 'cached' });
    getOperationState().begin(modelOperation('manifest-version-op', 'ManifestVersionRows'));
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    // The outbox reached the disk before the restart: this is what the migration must carry over.
    expect((storage.get('dbl:ops') ?? '').includes('manifest-version-op')).toBe(true);
    configureManifestRuntime(storage, 'build-2');
    await bootDb();

    expect(diagnostics.snapshot().dataLossEvents.some(event => event.mechanism === 'model-corruption-recovery')).toBe(false);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'data-version-migration-reset', model: '__runtime__', count: 1 });
    // The migration is a declared cache reset, so the cached rows are gone and the outbox is not.
    expect(rows.all()).toEqual([]);
    // The ledger record itself rides the migration verbatim and is closed by the boot fsck, per OP34,
    // as `rolledback` because this operation left no temp row or rollback snapshot behind.
    expect(getOperationState().get('manifest-version-op')).toMatchObject({ operationId: 'manifest-version-op', model: 'ManifestVersionRows', status: 'rolledback' });
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
    storage.set('dbl:sentinel', 'kept');

    configureManifestRuntime(storage, 'build-1');

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:sentinel')).toBe('kept');
  });

  it('cold-resets persisted data when the consumer changes from the default version to a build version', async () => {
    const storage = configureManifestRuntime();
    await bootDb();
    storage.set('dbl:sentinel', 'discard');

    configureManifestRuntime(storage, 'build-1');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('preserves persisted data across boots when the consumer omits the data version', async () => {
    const storage = configureManifestRuntime();
    await bootDb();
    storage.set('dbl:sentinel', 'kept');

    configureManifestRuntime(storage);

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(storage.get('dbl:sentinel')).toBe('kept');
  });

  it('cold-resets a format 7 single-fingerprint manifest like any other outdated format', async () => {
    const storage = configureManifestRuntime();
    storage.set('dbl:manifest', encodePersistence({ formatVersion: 7, schemaFingerprint: stableSerialize([declaration('manifest-format-7')]), dataVersion: null }));
    storage.set('dbl:sentinel', 'discard');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('clears only the changed model for a fingerprint mismatch', async () => {
    const storage = configureManifestRuntime();
    const alphaId = 'ManifestBlastAlpha';
    const betaId = 'ManifestBlastBeta';
    const defineAlpha = (extra: Record<string, unknown>) =>
      defineModelRuntime({ id: alphaId, name: alphaId, fields: { label: f.str(), ...extra }, scopes: { all: { by: { label: 'label' } } } });
    const defineBeta = () => defineModelRuntime({ id: betaId, name: betaId, fields: { label: f.str() }, scopes: { all: { by: { label: 'label' } } } });
    const alphaBefore = defineAlpha({});
    const betaBefore = defineBeta();
    await bootDb();
    alphaBefore.insert({ id: 'alpha-1', label: 'alpha' });
    betaBefore.insert({ id: 'beta-1', label: 'beta' });
    getApplyRuntime().flushCacheSnapshots();
    const alphaScopePrefix = compositeStorageKey('dbl:', 'scope', alphaId);
    expect(storage.keys(alphaScopePrefix).length).toBeGreaterThan(0);
    [
      { key: compositeStorageKey('dbl:', 'scope', alphaId, 'manual'), value: 'scope' },
      { key: compositeStorageKey('dbl:', 'tombstones', alphaId), value: encodePersistence({ 'alpha-stale': { at: 1 } }) },
      { key: 'dbl:query:keep', value: 'query' }
    ].forEach(entry => storage.set(entry.key, entry.value));

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

  it('[P3] keeps every model operation record and once key across a schema migration', async () => {
    const storage = configureManifestRuntime();
    const alphaId = 'ManifestLedgerAlpha';
    const betaId = 'ManifestLedgerBeta';
    defineManifestModel(alphaId);
    defineManifestModel(betaId);
    await bootDb();
    const ledger = getOperationState();
    ledger.begin(modelOperation('alpha-operation', alphaId, { rollbackRow: { id: `${alphaId}-row` }, rollbackMemberships: [] }));
    ledger.begin(modelOperation('beta-operation', betaId, { actionMode: 'durable' }));
    ledger.begin(modelOperation('beta-once-operation', betaId, { idempotencyKey: 'beta-once-key', once: true }));
    ledger.close('beta-once-operation', 'committed');
    expect(storage.get('dbl:ops')).toBeDefined();

    configureManifestRuntime(storage);
    defineManifestModel(alphaId, { added: f.str().nullDefault() });
    defineManifestModel(betaId);
    expect(storage.get('dbl:ops')).toBeDefined();
    await bootDb();

    // A schema migration wipes the model's cache namespaces only: the user's pending operations
    // keep their domain input and stay retryable across the bump.
    const restartedLedger = getOperationState();
    expect(restartedLedger.get('alpha-operation')).toBeDefined();
    expect(restartedLedger.get('beta-operation')).toBeDefined();
    expect(restartedLedger.get('beta-once-operation')).toBeDefined();
    expect(restartedLedger.hasCommitted('beta-once-key')).toBe(true);
    const operations = JSON.parse(storage.get('dbl:ops')!) as { payload: { operations: Record<string, OperationRecord>; committedKeys: string[] } };
    expect(operations.payload.operations).toHaveProperty('alpha-operation');
    expect(operations.payload.operations).toHaveProperty('beta-operation');
    expect(operations.payload.committedKeys).toContain('beta-once-key');
    expect(storage.get('dbl:ops-once')).toBeUndefined();
  });

  it('[P9] cold-resets format 4 keys before reading the injective composite-key format', async () => {
    const storage = configureManifestRuntime();
    storage.set('dbl:manifest', encodePersistence({ formatVersion: 4, schemaFingerprint: stableSerialize([declaration('manifest-format-4')]), dataVersion: null }));
    storage.set('dbl:sentinel', 'discard');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('cold-resets format 5 keys from the membership-edge era', async () => {
    const storage = configureManifestRuntime();
    storage.set('dbl:manifest', encodePersistence({ formatVersion: 5, schemaFingerprint: stableSerialize([declaration('manifest-format-5')]), dataVersion: null }));
    storage.set('dbl:sentinel', 'edge-era');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('records manifest-driven resets in diagnostics', async () => {
    const storage = configureManifestRuntime();
    storage.set('dbl:sentinel', 'discard');
    storage.set('dbl:manifest', encodePersistence({ formatVersion: 6, schemaFingerprint: 'outdated', dataVersion: null }));
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as {
      reset: () => void;
      snapshot: () => { manifestResets: number; dataLossEvents: Array<{ mechanism: string; model: string; count: number }> };
    };
    diagnostics.reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(diagnostics.snapshot().manifestResets).toBe(1);
    // An outdated manifest form does not decode, so the reset classifies as recovery from an unreadable manifest.
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'model-corruption-recovery', model: '__runtime__', count: 1 });
  });

  it('cold-resets a valid manifest with an unsupported format', async () => {
    const storage = configureManifestRuntime();
    defineManifestModel('ManifestUnsupportedFormat');
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION + 1, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    storage.set('dbl:sentinel', 'discard');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
  });

  it('resets nonempty storage without a manifest', async () => {
    const storage = configureManifestRuntime();
    storage.set('dbl:sentinel', 'discard');
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
    [
      { key: 'dbl:manifest', value: '{broken' },
      { key: 'dbl:sentinel', value: 'discard' }
    ].forEach(entry => storage.set(entry.key, entry.value));

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
      [
        { key: 'dbl:manifest', value },
        { key: 'dbl:sentinel', value: 'stale' }
      ].forEach(entry => storage.set(entry.key, entry.value));

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
      [
        { key: 'dbl:manifest', value: encodePersistence(payload) },
        { key: 'dbl:sentinel', value: 'stale' }
      ].forEach(entry => storage.set(entry.key, entry.value));
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
