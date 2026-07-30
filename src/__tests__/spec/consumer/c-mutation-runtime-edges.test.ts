import { configureDb, defineModel, f, getOperationState, hasMany, resetRuntime } from '../../legacyTestApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

const document = { kind: 'Document', definitions: [] } as never;
type EdgeRow = { id: string; bucket: string; label: string; note?: string };

const createRows = (suffix: string) =>
  defineModel({
    id: `MutationRuntimeEdges${suffix}`,
    name: `MutationRuntimeEdges${suffix}`,
    fields: { bucket: f.str(), label: f.str(), note: f.str().optional() },
    scopes: { bucket: ({ by: { bucket: 'bucket' } }) },
    maintenance: { dropTempRowsAfterMs: 1000 }
  });

describe('mutation runtime edges', () => {
  it('tracks an empty fabricated response without an optimistic write', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async <TData,>() => ({ data: { save: { row: null } } as TData }) })
    });
    const rows = createRows('EmptyRespond');
    const mutation = rows.mutation<{ save: { row: { id: string; bucket: string; label: string } | null } }, void, never, { id: string }>('save', {
      document,
      result: 'save',
      optimistic: {
        model: rows,
        respond: () => ({ save: { row: null } }),
        selectServerNode: data => data.save.row
      }
    });

    await expect(mutation.run()).resolves.toEqual({ row: null });
    expect(getOperationState().pending()).toEqual([]);
  });

  it('reconciles a fabricated row through the response planner', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({ data: { save: { row: { id: 'server-1', bucket: 'a', label: 'server' } } } as TData })
      })
    });
    const rows = createRows('RespondCommit');
    const mutation = rows.mutation<
      { save: { row: { id: string; bucket: string; label: string } } },
      { label: string },
      never,
      { id: string; bucket: string; label: string }
    >('save', {
      document,
      result: 'save',
      optimistic: {
        model: rows,
        respond: (input, { tempId }) => ({ save: { row: { id: tempId, bucket: 'a', label: input.label } } }),
        selectServerNode: data => data.save.row
      }
    });

    await expect(mutation.run({ label: 'local' })).resolves.toMatchObject({ row: { id: 'server-1' } });
    expect(rows.find('server-1')).toMatchObject({ label: 'server' });
  });

  it('drops a successful transport result whose data access changes generation', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() =>
          ({
            get data() {
              resetRuntime();
              return { save: { ok: true } } as TData;
            }
          }) as never
      })
    });
    const rows = createRows('GenerationAfterTransport');
    const mutation = rows.mutation<{ save: { ok: boolean } }, void, never, never>('save', { document, result: 'save' });

    await expect(mutation.run()).resolves.toBeNull();
  });

  it('drops a payload getter failure that changes generation before throwing', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({
          data: Object.defineProperty({}, 'save', {
            get() {
              resetRuntime();
              throw new Error('stale payload getter');
            }
          }) as TData
        })
      })
    });
    const rows = createRows('GenerationInPayload');
    const mutation = rows.mutation<{ save: { ok: boolean } }, void, never, never>('save', { document, result: 'save' });

    await expect(mutation.run()).resolves.toBeNull();
  });

  it('restores a destroyed row and its scope membership after failure', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) })
    });
    const rows = createRows('DestroyRestore');
    rows.scopes.bucket.seed({ bucket: 'a' }, [{ id: 'row-1', bucket: 'a', label: 'before' }]);
    const mutation = rows.mutation<{ save: { ok: boolean } }, { id: string }, never, never>('save', {
      document,
      result: 'save',
      optimistic: {
        method: 'destroy',
        model: rows,
        selectId: input => input.id
      },
      dedupe: false
    });

    await expect(mutation.run({ id: 'row-1' })).rejects.toThrow('offline');
    expect(rows.find('row-1')).toMatchObject({ label: 'before' });
    expect(rows.scopes.bucket.read({ bucket: 'a' }).map(row => row.id)).toEqual(['row-1']);
  });

  it('contains post-commit callback and logger failures without skipping later callbacks', async () => {
    const onSyncError = jest.fn();
    const loggerError = jest.fn(() => {
      throw new Error('logger failure');
    });
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async <TData,>() => ({ data: { save: { ok: true } } as TData }) }),
      logger: { debug: () => undefined, error: loggerError },
      defaults: { onSyncError }
    });
    const rows = createRows('CallbackIsolation');
    const tracked = jest.fn();
    const callbackFailure: unknown = 'commit callback failure';
    const mutation = rows.mutation<{ save: { ok: boolean } }, void, never, never>('save', {
      document,
      result: 'save',
      onCommit: () => {
        throw callbackFailure;
      },
      invalidate: () => {
        throw new Error('invalidate callback failure');
      },
      track: tracked
    });

    await expect(mutation.run()).resolves.toEqual({ ok: true });
    expect(loggerError).toHaveBeenCalledTimes(2);
    expect(onSyncError).toHaveBeenCalledTimes(2);
    expect(tracked).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing temporary row without dedupe and omits an unserializable failed input', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async <TData,>() => ({ data: { save: { row: null } } as TData }) })
    });
    const rows = createRows('ReuseExisting');
    rows.insert({ id: 'temp-existing', bucket: 'a', label: 'existing' });
    const mutation = rows.mutation<{ save: { row: null } }, { self?: unknown }, EdgeRow, never>('save', {
      document,
      result: 'save',
      dedupe: false,
      optimistic: {
        model: rows,
        existingTempId: () => 'temp-existing',
        build: (_input, { tempId }) => ({ id: tempId!, bucket: 'a', label: 'unused' }),
        selectServerNode: () => null
      }
    });
    const input: { self?: unknown } = {};
    input.self = input;

    await expect(mutation.run(input)).resolves.toEqual({ row: null });
    expect(rows.find('temp-existing')).toMatchObject({ label: 'existing' });
  });

  it('keeps extract operations for another model outside method-patch ownership', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({ data: { save: { audit: { id: 'audit-1', bucket: 'audit', label: 'written' } } } as TData })
      })
    });
    const rows = createRows('PatchExtract');
    const audits = createRows('PatchExtractAudit');
    rows.insert({ id: 'row-1', bucket: 'a', label: 'before' });
    const mutation = rows.mutation<
      { save: { audit: EdgeRow } },
      { id: string },
      EdgeRow,
      never
    >('save', {
      document,
      result: 'save',
      optimistic: {
        method: 'patch',
        model: rows,
        selectId: input => input.id,
        selectPatch: () => ({ label: 'optimistic' })
      },
      extract: ({ data }) => [{ into: audits, rows: [data.save.audit] }]
    });

    await expect(mutation.run({ id: 'row-1' })).resolves.toMatchObject({ audit: { id: 'audit-1' } });
    expect(audits.find('audit-1')).toMatchObject({ label: 'written' });
  });

  it('removes an optimistic optional field that was absent before a failed patch', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({ mutation: async () => Promise.reject(new Error('offline')) })
    });
    const rows = createRows('PatchAbsentField');
    rows.insert({ id: 'row-1', bucket: 'a', label: 'before' });
    const mutation = rows.mutation<{ save: { ok: boolean } }, { id: string }, EdgeRow, never>('save', {
      document,
      result: 'save',
      dedupe: false,
      optimistic: {
        method: 'patch',
        model: rows,
        selectId: input => input.id,
        selectPatch: () => ({ note: 'temporary' })
      }
    });

    await expect(mutation.run({ id: 'row-1' })).rejects.toThrow('offline');
    expect(rows.find('row-1')).not.toHaveProperty('note');
  });

  it('makes retry and discard no-ops for unsupported or absent failed records', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const rows = createRows('RetryDiscardGuards');
    const plain = rows.mutation<{ save: { ok: boolean } }, void, never, never>('plain', { document, result: 'save' });
    const patch = rows.mutation<{ save: { ok: boolean } }, { id: string }, EdgeRow, never>('patch', {
      document,
      result: 'save',
      optimistic: { method: 'patch', model: rows, selectId: input => input.id, selectPatch: () => ({ label: 'patch' }) }
    });
    const respond = rows.mutation<{ save: { row: null } }, void, never, never>('respond', {
      document,
      result: 'save',
      optimistic: { model: rows, respond: () => ({ save: { row: null } }), selectServerNode: () => null }
    });
    const insert = rows.mutation<{ save: { row: null } }, void, { id: string; bucket: string; label: string }, never>('insert', {
      document,
      result: 'save',
      optimistic: {
        model: rows,
        build: (_input, { tempId }) => ({ id: tempId!, bucket: 'a', label: 'insert' }),
        selectServerNode: () => null
      }
    });

    await expect(plain.retry('missing')).resolves.toBeNull();
    expect(() => plain.discard('missing')).not.toThrow();
    expect(() => patch.discard('missing')).not.toThrow();
    expect(() => respond.discard('missing')).not.toThrow();
    expect(() => insert.discard('missing')).not.toThrow();
  });

  it('rejects direct optimistic destroy when dependent rows exist', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const children = defineModel({
      id: 'MutationRuntimeCascadeChildren',
      name: 'MutationRuntimeCascadeChildren',
      fields: { parentId: f.str() }
    });
    const cascadedParents = defineModel({
      id: 'MutationRuntimeCascadeOwnedParents',
      name: 'MutationRuntimeCascadeOwnedParents',
      fields: { label: f.str() },
      relations: () => ({
        children: hasMany(children, { foreignKey: 'parentId', dependent: 'destroy' })
      })
    });
    cascadedParents.insert({ id: 'parent-1', label: 'parent' });
    const mutation = cascadedParents.mutation<{ save: { ok: boolean } }, { id: string }, never, never>('destroy', {
      document,
      result: 'save',
      optimistic: { method: 'destroy', model: cascadedParents, selectId: input => input.id }
    });

    await expect(mutation.run({ id: 'parent-1' })).rejects.toThrow('optimistic destroy is not supported');
    expect(cascadedParents.find('parent-1')).toMatchObject({ label: 'parent' });
  });
});
