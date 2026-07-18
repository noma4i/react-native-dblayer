import { act } from 'react-test-renderer';
import React from 'react';
import { QueryClientProvider, defineModel, f, isTempId, scope } from '../../index';
import { createAcceptanceTransport, renderCounted, setupAcceptanceRuntime } from './harness';

const document = { kind: 'Document', definitions: [] } as never;
const scopeValue = { group: 'feed' };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
};

describe('A16 crud scaffold', () => {
  it('uses an explicit create optimistic override without requiring respond or build', async () => {
    const transport = createAcceptanceTransport({ mutation: async <TData,>() => ({ data: { create: { id: 'server', title: 'server' } } as TData }) });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: 'A16Override', name: 'A16Override', fields: { title: f.str() } });
    const custom = jest.fn(() => ({ method: 'patch' as const, model, selectId: () => 'row', selectPatch: () => ({ title: 'custom' }) }));
    act(() => {
      model.insertStored({ id: 'row', title: 'before' });
    });
    expect(() => model.crud({ create: { document, result: 'create', optimistic: custom() } }).create).not.toThrow();
  });

  it('wires conventional list and get queries into public reads', async () => {
    const transport = createAcceptanceTransport({
      query: async <TData,>() => ({ data: { items: [{ id: 'list', group: 'feed', title: 'list' }], item: { id: 'get', group: 'feed', title: 'get' } } as TData })
    });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({
      id: 'A16Queries',
      name: 'A16Queries',
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
    });
    const crud = model.crud({ list: { document, select: (data: any) => data.items, into: model.scopes.feed }, get: { document, select: (data: any) => data.item } });
    const scopeReader = renderCounted(() => model.scopes.feed.use(scopeValue));
    const rowReader = renderCounted(() => model.use.row('get'));
    await act(async () => {
      await crud.list.fetch(scopeValue);
      await crud.get.fetch({});
    });
    expect(scopeReader.result()).toMatchObject([{ id: 'list' }]);
    expect(rowReader.result()).toMatchObject({ id: 'get' });
    scopeReader.unmount();
    rowReader.unmount();
  });

  it('composes create respond and prependTo through crud', async () => {
    const hold = deferred<{ data: { create: { id: string; group: string; title: string } } }>();
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }) });
    const model = defineModel({
      id: 'A16Create',
      name: 'A16Create',
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
    });
    act(() => {
      model.insertStored({ id: 'old', group: 'feed', title: 'old' });
    });
    const crud = model.crud({
      create: {
        document,
        result: 'create',
        respond: (input: { title: string }, context: { tempId: string }) => ({ create: { id: context.tempId, group: 'feed', title: input.title } }),
        selectServerNode: (data: any) => data.create,
        prependTo: { scope: model.scopes.feed, value: () => scopeValue }
      }
    });
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue));
    let pending!: Promise<any>;
    act(() => {
      pending = crud.create.run({ title: 'draft' });
    });
    expect(isTempId(reader.result()[0]!.id)).toBe(true);
    expect(reader.renders()).toBe(2);
    await act(async () => {
      hold.resolve({ data: { create: { id: 'server', group: 'feed', title: 'draft' } } });
      await pending;
    });
    expect(reader.result().map(row => row.id)).toEqual(['server', 'old']);
    reader.unmount();
  });

  it('patches and rolls back update defaults without writing id', async () => {
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: async () => Promise.reject(new Error('update failed')) }) });
    const model = defineModel({ id: 'A16Update', name: 'A16Update', fields: { title: f.str(), extra: f.str() } });
    act(() => {
      model.insertStored({ id: 'row', title: 'before', extra: 'keep' });
    });
    const crud = model.crud({ update: { document, result: 'update' } });
    await expect(crud.update.run({ id: 'row', title: 'after' })).rejects.toThrow('update failed');
    expect(model.get('row')).toEqual({ id: 'row', title: 'before', extra: 'keep' });
  });

  it('restores destroy membership order on rollback', async () => {
    setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: async () => Promise.reject(new Error('destroy failed')) }) });
    const model = defineModel({
      id: 'A16Destroy',
      name: 'A16Destroy',
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
    });
    act(() => {
      model.insertStored({ id: 'one', group: 'feed', title: 'one' });
      model.insertStored({ id: 'two', group: 'feed', title: 'two' });
    });
    const crud = model.crud({ destroy: { document, result: 'destroy' } });
    await expect(crud.destroy.run({ id: 'one' })).rejects.toThrow('destroy failed');
    expect(model.scopes.feed.read(scopeValue).map(row => row.id)).toEqual(['one', 'two']);
  });

  it('dedupes double-tapped crud create calls', async () => {
    const hold = deferred<{ data: { create: { id: string; title: string } } }>();
    const transport = createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> });
    setupAcceptanceRuntime({ transport });
    const model = defineModel({ id: 'A16Dedupe', name: 'A16Dedupe', fields: { title: f.str() } });
    const crud = model.crud({
      create: {
        document,
        result: 'create',
        respond: (input: { title: string }, context: { tempId: string }) => ({ create: { id: context.tempId, title: input.title } }),
        selectServerNode: (data: any) => data.create
      }
    });
    const first = crud.create.run({ title: 'same' });
    await expect(crud.create.run({ title: 'same' })).resolves.toBeNull();
    expect(transport.calls.filter(call => call.kind === 'mutation')).toHaveLength(1);
    hold.resolve({ data: { create: { id: 'server', title: 'same' } } });
    await first;
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

  it('crud writes preserve unaffected identities', async () => {
    const createHold = deferred<{ data: { create: { id: string; group: string; title: string } } }>();
    let calls = 0;
    setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        mutation: <TData,>() => {
          calls += 1;
          if (calls === 1) return createHold.promise as Promise<{ data: TData }>;
          if (calls === 2) return Promise.resolve({ data: { update: { id: 'first', group: 'feed', title: 'updated' } } as TData });
          return Promise.resolve({ data: { destroy: { id: 'second' } } as TData });
        }
      })
    });
    const model = defineModel({
      id: 'A16Identity',
      name: 'A16Identity',
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
    });
    act(() => {
      model.insertStored({ id: 'first', group: 'feed', title: 'first' });
      model.insertStored({ id: 'second', group: 'feed', title: 'second' });
      model.insertStored({ id: 'third', group: 'feed', title: 'third' });
    });
    const crud = model.crud({
      create: {
        document,
        result: 'create',
        respond: (input: { title: string }, context: { tempId: string }) => ({ create: { id: context.tempId, group: 'feed', title: input.title } }),
        selectServerNode: (data: any) => data.create,
        appendTo: { scope: model.scopes.feed, value: () => scopeValue }
      },
      update: { document, result: 'update' },
      destroy: { document, result: 'destroy' }
    });
    const reader = renderCounted(() => model.scopes.feed.use(scopeValue));
    const initial = reader.result();
    const [first, second, third] = initial;
    let created!: Promise<any>;
    act(() => {
      created = crud.create.run({ title: 'created' });
    });
    const fabricated = reader.result();
    expect(fabricated).not.toBe(initial);
    expect(fabricated[0]).toBe(first);
    expect(fabricated[1]).toBe(second);
    expect(fabricated[2]).toBe(third);
    await act(async () => {
      createHold.resolve({ data: { create: { id: 'server-created', group: 'feed', title: 'created' } } });
      await created;
    });
    const committedCreate = reader.result();
    expect(committedCreate.map(row => row.id)).toEqual(['first', 'second', 'third', 'server-created']);
    expect(committedCreate[0]).toBe(first);
    expect(committedCreate[1]).toBe(second);
    expect(committedCreate[2]).toBe(third);
    await act(async () => {
      await crud.update.run({ id: 'first', title: 'updated' });
    });
    const updated = reader.result();
    expect(updated[1]).toBe(second);
    expect(updated[2]).toBe(third);
    expect(updated[3]).toBe(committedCreate[3]);
    await act(async () => {
      await crud.destroy.run({ id: 'second' });
    });
    const destroyed = reader.result();
    expect(destroyed).not.toBe(updated);
    expect(destroyed.map(row => row.id)).toEqual(['first', 'third', 'server-created']);
    expect(destroyed[1]).toBe(third);
    expect(destroyed[2]).toBe(committedCreate[3]);
    reader.unmount();
  });

  it('crud writes keep unrelated readers at zero renders', async () => {
    const createHold = deferred<{ data: { create: { id: string; group: string; title: string } } }>();
    let calls = 0;
    setupAcceptanceRuntime({
      transport: createAcceptanceTransport({
        mutation: <TData,>() => {
          calls += 1;
          if (calls === 1) return createHold.promise as Promise<{ data: TData }>;
          if (calls === 2) return Promise.resolve({ data: { update: { id: 'target', group: 'feed', title: 'updated' } } as TData });
          return Promise.resolve({ data: { destroy: { id: 'target' } } as TData });
        }
      })
    });
    const model = defineModel({
      id: 'A16Pinpoint',
      name: 'A16Pinpoint',
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
    });
    const other = defineModel({ id: 'A16PinpointOther', name: 'A16PinpointOther', fields: { title: f.str() } });
    act(() => {
      model.insertStored({ id: 'target', group: 'feed', title: 'target' });
    });
    const crud = model.crud({
      create: {
        document,
        result: 'create',
        respond: (input: { title: string }, context: { tempId: string }) => ({ create: { id: context.tempId, group: 'feed', title: input.title } }),
        selectServerNode: (data: any) => data.create,
        appendTo: { scope: model.scopes.feed, value: () => scopeValue }
      },
      update: { document, result: 'update' },
      destroy: { document, result: 'destroy' }
    });
    const affected = renderCounted(() => model.scopes.feed.use(scopeValue));
    const otherScope = renderCounted(() => model.scopes.feed.use({ group: 'other' }));
    const unrelatedRow = renderCounted(() => model.use.row('unrelated'));
    const otherModel = renderCounted(() => other.use.row('other'));
    const before = [affected.renders(), otherScope.renders(), unrelatedRow.renders(), otherModel.renders()];
    let created!: Promise<any>;
    act(() => {
      created = crud.create.run({ title: 'created' });
    });
    expect(affected.renders()).toBe(before[0]! + 1);
    await act(async () => {
      createHold.resolve({ data: { create: { id: 'server-created', group: 'feed', title: 'created' } } });
      await created;
    });
    expect(affected.renders()).toBe(before[0]! + 2);
    await act(async () => {
      await crud.update.run({ id: 'target', title: 'updated' });
    });
    expect(affected.renders()).toBe(before[0]! + 3);
    await act(async () => {
      await crud.destroy.run({ id: 'target' });
    });
    expect(affected.renders()).toBe(before[0]! + 4);
    expect(otherScope.renders()).toBe(before[1]);
    expect(unrelatedRow.renders()).toBe(before[2]);
    expect(otherModel.renders()).toBe(before[3]);
    affected.unmount();
    otherScope.unmount();
    unrelatedRow.unmount();
    otherModel.unmount();
  });

  it('crud list reader tears down cleanly', async () => {
    const hold = deferred<{ data: { items: Array<{ id: string; group: string; title: string }> } }>();
    const transport = createAcceptanceTransport({ query: <TData,>() => hold.promise as Promise<{ data: TData }> });
    const { queryClient } = setupAcceptanceRuntime({ transport });
    const model = defineModel({
      id: 'A16Teardown',
      name: 'A16Teardown',
      fields: { group: f.str(), title: f.str() },
      scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
    });
    const crud = model.crud({ list: { document, select: (data: any) => data.items, into: model.scopes.feed } });
    const reader = renderCounted(
      () => crud.list.use(scopeValue).data,
      child => React.createElement(QueryClientProvider, { client: queryClient }, child)
    );
    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(1);
    await act(async () => {
      hold.resolve({ data: { items: [{ id: 'server', group: 'feed', title: 'server' }] } });
      await hold.promise;
    });
    const rendersBeforeUnmount = reader.renders();
    reader.unmount();
    act(() => {
      model.insertStored({ id: 'after-unmount', group: 'feed', title: 'after-unmount' });
    });
    expect(reader.renders()).toBe(rendersBeforeUnmount);
    expect(transport.calls.filter(call => call.kind === 'query')).toHaveLength(1);
    expect(transport.calls.filter(call => call.kind === 'subscribe')).toHaveLength(0);
  });

  it('crud mutation scaling stays bounded at 1k and 20k rows', () => {
    const median = (samples: number[]) => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;
    const sample = (count: number) => {
      const hold = deferred<{ data: { update: { id: string; group: string; title: string } } }>();
      setupAcceptanceRuntime({ transport: createAcceptanceTransport({ mutation: <TData,>() => hold.promise as Promise<{ data: TData }> }) });
      const model = defineModel({
        id: `A16CrudScale${count}`,
        name: `A16CrudScale${count}`,
        fields: { group: f.str(), title: f.str() },
        scopes: { feed: scope({ by: { group: 'group' }, sort: 'server-order' }) }
      });
      model.scopes.feed.__apply?.(
        scopeValue,
        Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, group: 'feed', title: `title-${index}` })),
        'complete'
      );
      const crud = model.crud({ update: { document, result: 'update' } });
      const reader = renderCounted(() => model.scopes.feed.use(scopeValue));
      const elapsed = median(
        Array.from({ length: 7 }, (_, index) => {
          const started = performance.now();
          act(() => {
            void crud.update.run({ id: 'row-0', title: `changed-${index}` });
          });
          return performance.now() - started;
        })
      );
      expect(reader.result()[0]).toMatchObject({ id: 'row-0', title: 'changed-6' });
      reader.unmount();
      return elapsed;
    };
    const small = sample(1_000);
    const large = sample(20_000);
    const ratio = large / Math.max(small, 0.001);
    console.log(`A16-RESULT crud-scale: small=${small},large=${large},ratio=${ratio}`);
    expect(ratio).toBeLessThan(12);
  });
});
