import { act } from 'react-test-renderer';
import { defineModel, f, isTempId, scope } from '../../index';
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness';

const document = { kind: 'Document', definitions: [] } as never;
const scopeValue = { group: 'feed' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; };

describe('A16 crud scaffold', () => {
  it('uses an explicit create optimistic override without requiring respond or build', async () => {
    const transport = createAcceptanceTransport({ mutation: async <TData,>() => ({ data: { create: { id: 'server', title: 'server' } } as TData }) });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: 'A16Override', name: 'A16Override', fields: { title: f.str() } });
    const custom = jest.fn(() => ({ method: 'patch' as const, model, selectId: () => 'row', selectPatch: () => ({ title: 'custom' }) }));
    act(() => { model.insertStored({ id: 'row', title: 'before' }); });
    expect(() => model.crud({ create: { document, result: 'create', optimistic: custom() } }).create).not.toThrow();
  });

  it('wires conventional list and get queries into public reads', async () => {
    const transport = createAcceptanceTransport({ query: async <TData,>() => ({ data: { items: [{ id: 'list', group: 'feed', title: 'list' }], item: { id: 'get', group: 'feed', title: 'get' } } as TData }) });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: 'A16Queries', name: 'A16Queries', fields: { group: f.str(), title: f.str() }, scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) } });
    const crud = model.crud({ list: { document, select: (data: any) => data.items, into: model.scopes.feed }, get: { document, select: (data: any) => data.item } });
    const scopeReader = renderCounted(() => model.scopes.feed.use(scopeValue));
    const rowReader = renderCounted(() => model.use.row('get'));
    await act(async () => { await crud.list.fetch(scopeValue); await crud.get.fetch({}); });
    expect(scopeReader.result()).toMatchObject([{ id: 'list' }]);
    expect(rowReader.result()).toMatchObject({ id: 'get' });
    scopeReader.unmount(); rowReader.unmount();
  });

  it('composes create respond and prependTo through crud', async () => {
    const hold = deferred<{ data: { create: { id: string; group: string; title: string } } }>();
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }) });
    const model = defineModel({ id: 'A16Create', name: 'A16Create', fields: { group: f.str(), title: f.str() }, scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) } });
    act(() => { model.insertStored({ id: 'old', group: 'feed', title: 'old' }); });
    const crud = model.crud({ create: { document, result: 'create', respond: (input: { title: string }, context: { tempId: string }) => ({ create: { id: context.tempId, group: 'feed', title: input.title } }), selectServerNode: (data: any) => data.create, prependTo: { scope: model.scopes.feed, value: () => scopeValue } } });
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue)); let pending!: Promise<any>;
    act(() => { pending = crud.create.run({ title: 'draft' }); });
    expect(isTempId(reader.result()[0]!.id)).toBe(true); expect(reader.renders()).toBe(2);
    await act(async () => { hold.resolve({ data: { create: { id: 'server', group: 'feed', title: 'draft' } } }); await pending; });
    expect(reader.result().map(row => row.id)).toEqual(['server', 'old']); reader.unmount();
  });

  it('patches and rolls back update defaults without writing id', async () => {
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: async () => Promise.reject(new Error('update failed')) }) });
    const model = defineModel({ id: 'A16Update', name: 'A16Update', fields: { title: f.str(), extra: f.str() } }); act(() => { model.insertStored({ id: 'row', title: 'before', extra: 'keep' }); });
    const crud = model.crud({ update: { document, result: 'update' } }); await expect(crud.update.run({ id: 'row', title: 'after' })).rejects.toThrow('update failed');
    expect(model.get('row')).toEqual({ id: 'row', title: 'before', extra: 'keep' });
  });

  it('restores destroy membership order on rollback', async () => {
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: async () => Promise.reject(new Error('destroy failed')) }) });
    const model = defineModel({ id: 'A16Destroy', name: 'A16Destroy', fields: { group: f.str(), title: f.str() }, scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) } }); act(() => { model.insertStored({ id: 'one', group: 'feed', title: 'one' }); model.insertStored({ id: 'two', group: 'feed', title: 'two' }); });
    const crud = model.crud({ destroy: { document, result: 'destroy' } }); await expect(crud.destroy.run({ id: 'one' })).rejects.toThrow('destroy failed');
    expect(model.scopes.feed.read(scopeValue).map(row => row.id)).toEqual(['one', 'two']);
  });

  it('dedupes double-tapped crud create calls', async () => {
    const hold = deferred<{ data: { create: { id: string; title: string } } }>(); const transport = createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }); setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: 'A16Dedupe', name: 'A16Dedupe', fields: { title: f.str() } }); const crud = model.crud({ create: { document, result: 'create', respond: (input: { title: string }, context: { tempId: string }) => ({ create: { id: context.tempId, title: input.title } }), selectServerNode: (data: any) => data.create } });
    const first = crud.create.run({ title: 'same' }); await expect(crud.create.run({ title: 'same' })).resolves.toBeNull(); expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1); hold.resolve({ data: { create: { id: 'server', title: 'same' } } }); await first;
  });

  it('throws at define time for a list without into', () => {
    setupAcceptanceRuntime();
    const model = defineModel({ id: 'A16ListRequired', name: 'A16ListRequired', fields: { title: f.str() } });
    expect(() => model.crud({ list: { document, select: () => [] } as never })).toThrow('crud list requires an explicit into scope');
  });

  it('rejects conventional update input without id at compile time', () => {
    const model = defineModel({ id: 'A16UpdateId', name: 'A16UpdateId', fields: { title: f.str() } });
    const crud = model.crud({ update: { document, result: 'update' } });
    if (false) {
      // @ts-expect-error conventional update requires input.id
      void crud.update.run({ title: 'x' });
    }
    expect(crud.update).toBeDefined();
  });
});
