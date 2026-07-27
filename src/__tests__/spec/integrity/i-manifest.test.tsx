import { configureDb, defineShape, f } from '../../../index';
import { DB_FORMAT_VERSION, computeSchemaFingerprint, registerSchemaDeclaration, type SchemaDeclaration, writePersistenceManifest } from '../../../core/schemaManifest';
import { bootDb } from '../../../dsl/lifecycle';
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

const configureManifestRuntime = (storage = createMemoryPlane(), dataVersion?: string) => {
  configureDb({ storage, transport: createMockTransport(), dataVersion });
  return storage;
};

describe('persistence schema manifest', () => {
  it('labels every field builder and preserves default metadata through modifiers', () => {
    const shape = defineShape()({ label: f.str() });
    const fields = [f.str(), f.num(), f.date(), f.bool(), f.id(), f.enum(['draft'] as const), f.raw(), f.custom(value => value), f.object(shape), f.array(f.str())];

    expect(fields.map(field => field.kind)).toEqual(['str', 'num', 'date', 'bool', 'id', 'enum', 'raw', 'custom', 'object', 'array']);
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
    const fingerprint = computeSchemaFingerprint();
    registerSchemaDeclaration(first);
    registerSchemaDeclaration(second);

    expect(computeSchemaFingerprint()).toBe(fingerprint);
  });

  it('changes the fingerprint for field and scope declarations', () => {
    const id = 'manifest-sensitive';
    registerSchemaDeclaration(declaration(id));
    const baseline = computeSchemaFingerprint();

    registerSchemaDeclaration(declaration(id, { title: { kind: 'num', mode: 'required', hasDefault: false } }));
    expect(computeSchemaFingerprint()).not.toBe(baseline);

    registerSchemaDeclaration(declaration(id, { title: { kind: 'str', mode: 'nullable', hasDefault: false } }));
    expect(computeSchemaFingerprint()).not.toBe(baseline);

    registerSchemaDeclaration(
      declaration(id, {
        title: { kind: 'str', mode: 'required', hasDefault: false },
        subtitle: { kind: 'str', mode: 'required', hasDefault: false }
      })
    );
    expect(computeSchemaFingerprint()).not.toBe(baseline);

    registerSchemaDeclaration(declaration(id));
    expect(computeSchemaFingerprint()).toBe(baseline);

    registerSchemaDeclaration(declaration(id, undefined, { feed: { by: { ownerId: 'ownerId' }, sort: 'server-order' } }));
    const scoped = computeSchemaFingerprint();
    expect(scoped).not.toBe(baseline);

    registerSchemaDeclaration(declaration(id, undefined, { feed: { by: { ownerId: 'authorId' }, sort: 'field:createdAt:desc' } }));
    expect(computeSchemaFingerprint()).not.toBe(scoped);
  });

  it('writes a manifest for an empty boot without resetting', async () => {
    const storage = configureManifestRuntime();

    await expect(bootDb()).resolves.toMatchObject({ reset: false });
    expect(JSON.parse(storage.get('dbl:manifest')!)).toEqual({ formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: null });
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
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as { reset: () => void; snapshot: () => { manifestResets: number; dataLossEvents: Array<{ mechanism: string; model: string; count: number }> } };
    diagnostics.reset();

    configureManifestRuntime(storage, 'build-2');

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
    expect(JSON.parse(storage.get('dbl:manifest')!)).toEqual({ formatVersion: DB_FORMAT_VERSION, schemaFingerprint: computeSchemaFingerprint(), dataVersion: 'build-2' });
    expect(diagnostics.snapshot().manifestResets).toBe(1);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'model-corruption-recovery', model: '__runtime__', count: 1 });
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

  it('resets every persisted key for a mismatched fingerprint', async () => {
    const storage = configureManifestRuntime();
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: 'outdated', dataVersion: null });

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
    expect(storage.snapshotKeys()).toEqual(['dbl:manifest']);
  });

  it('records manifest-driven resets in diagnostics', async () => {
    const storage = configureManifestRuntime();
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprint: 'outdated', dataVersion: null });
    const diagnostics = (globalThis as Record<string, unknown>).__DBLAYER_DIAGNOSTICS__ as { reset: () => void; snapshot: () => { manifestResets: number; dataLossEvents: Array<{ mechanism: string; model: string; count: number }> } };
    diagnostics.reset();

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(diagnostics.snapshot().manifestResets).toBe(1);
    expect(diagnostics.snapshot().dataLossEvents).toContainEqual({ mechanism: 'model-corruption-recovery', model: '__runtime__', count: 1 });
  });

  it('resets nonempty storage without a manifest', async () => {
    const storage = configureManifestRuntime();
    storage.set([{ key: 'dbl:sentinel', value: 'discard' }]);

    await expect(bootDb()).resolves.toMatchObject({ reset: true });
    expect(storage.get('dbl:sentinel')).toBeUndefined();
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
