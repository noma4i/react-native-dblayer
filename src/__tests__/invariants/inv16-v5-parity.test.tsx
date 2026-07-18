import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parse } from 'graphql';
import TestRenderer, { act } from 'react-test-renderer';
import { ROOT_SCOPE_KEY, buildScopeKey } from '../../core/compileDbWhere';
import { belongsTo, hasMany } from '../../core/relations';
import { configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { defineCommand } from '../../index';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import type { StoragePlane } from '../../core/planes/storagePlane';

const queryDocument = parse('query ParityItems { items { id name } }');
const mutationDocument = parse('mutation RetryMessage { messageSend { message { id text } } }');

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => {
      for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value);
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const configure = (transport: { query?: () => Promise<{ data: unknown }>; mutation?: () => Promise<{ data: unknown }> } = {}) => {
  configureDb({
    storage: createStorage(),
    transport: {
      query: async () => transport.query?.() ?? { data: { items: [] } },
      mutation: async () => transport.mutation?.() ?? { data: {} }
    } as any
  });
};

const renderHook = <TProps, TResult>(read: (props: TProps) => TResult, initialProps: TProps) => {
  let current!: TResult;
  let root!: TestRenderer.ReactTestRenderer;
  const Reader = ({ props }: { props: TProps }) => {
    current = read(props);
    return null;
  };
  act(() => {
    root = TestRenderer.create(<Reader props={initialProps} />);
  });
  return {
    get current() {
      return current;
    },
    rerender: (props: TProps) => act(() => root.update(<Reader props={props} />)),
    unmount: () => act(() => root.unmount())
  };
};

const renderQuery = <TProps, TResult>(client: QueryClient, read: (props: TProps) => TResult, initialProps: TProps) => {
  let current!: TResult;
  let root!: TestRenderer.ReactTestRenderer;
  const Reader = ({ props }: { props: TProps }) => {
    current = read(props);
    return null;
  };
  act(() => {
    root = TestRenderer.create(<QueryClientProvider client={client}><Reader props={initialProps} /></QueryClientProvider>);
  });
  return {
    get current() {
      return current;
    },
    rerender: (props: TProps) => act(() => root.update(<QueryClientProvider client={client}><Reader props={props} /></QueryClientProvider>)),
    unmount: () => act(() => root.unmount())
  };
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
  throw new Error('condition did not settle');
};

describe('v6 invariant 16: v5 parity', () => {
  it('A. keeps base model statics and rejects collisions', () => {
    configure();
    const model = defineModel({
      id: 'parity-statics',
      name: 'ParityStaticsModel',
      fields: { name: f.str() },
      statics: () => ({ findByName: (name: string) => name.toUpperCase() })
    });

    expect(model.get).toEqual(expect.any(Function));
    expect(model.findByName('parity')).toBe('PARITY');
    expect(() => defineModel({
      id: 'parity-collision',
      name: 'ParityCollisionModel',
      fields: { name: f.str() },
      statics: () => ({ get: () => undefined })
    })).toThrow('ParityCollisionModel statics collide with base model key get');
  });

  it('B. uses merge shouldOverwrite to preserve newer stored rows', () => {
    configure();
    const model = defineModel({
      id: 'parity-versioned',
      name: 'ParityVersionedModel',
      fields: { version: f.num(), name: f.str() },
      merge: { shouldOverwrite: (existing: any, incoming: any) => incoming.version >= existing.version }
    });

    model.insertStored({ id: 'row-1', version: 2, name: 'newer' });
    model.insertStored({ id: 'row-1', version: 1, name: 'older' });
    expect(model.get('row-1')).toEqual({ id: 'row-1', version: 2, name: 'newer' });
    model.insertStored({ id: 'row-1', version: 3, name: 'latest' });
    expect(model.get('row-1')).toEqual({ id: 'row-1', version: 3, name: 'latest' });
  });

  it('C. shares canonical scope keys between scope writes and reads', () => {
    configure();
    expect(buildScopeKey({})).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey(undefined)).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey({ a: undefined })).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey({ b: 1, a: undefined })).toBe(buildScopeKey({ b: 1 }));
    expect(buildScopeKey({ b: 1, a: 2 })).toBe(buildScopeKey({ a: 2, b: 1 }));

    const model = defineModel({
      id: 'parity-scopes',
      name: 'ParityScopesModel',
      fields: { name: f.str() },
      scopes: { list: scope({ sort: 'server-order' }) }
    });
    model.scopes.list.__apply?.({ a: undefined, b: 1 }, [{ id: 'row-1', name: 'visible' }], 'complete');

    expect(model.scopes.list.read({ b: 1 })).toEqual([{ id: 'row-1', name: 'visible' }]);
  });

  it('primitive scope values get distinct keys', () => {
    expect(buildScopeKey('u1')).not.toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey('u1')).not.toBe(buildScopeKey('u2'));
    expect(buildScopeKey(7)).not.toBe(buildScopeKey('7'));
    expect(buildScopeKey(['a'])).not.toBe(ROOT_SCOPE_KEY);
  });

  it('nullish and empty-object scopes stay on the root key', () => {
    expect(buildScopeKey(undefined)).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey(null)).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey({})).toBe(ROOT_SCOPE_KEY);
    expect(buildScopeKey({ a: undefined })).toBe(ROOT_SCOPE_KEY);
  });

  it('record scopes keep their existing canonical keys', () => {
    expect(buildScopeKey({ chatId: '1' })).toBe(buildScopeKey({ chatId: '1' }));
    expect(buildScopeKey({ b: 1, a: 2 })).toBe(buildScopeKey({ a: 2, b: 1 }));
  });

  it('D. reuses an existing temporary row across a failed retry and commit', async () => {
    const outcomes: Array<Promise<{ data: unknown }>> = [
      Promise.reject(new Error('network failed')),
      Promise.resolve({ data: { messageSend: { message: { id: 'server-1', text: 'sent' } } } })
    ];
    configure({ mutation: () => outcomes.shift()! });
    const messages = defineModel({ id: 'parity-retry-messages', name: 'ParityRetryMessageModel', fields: { text: f.str() } });
    const tempId = 'temp-retry';
    messages.insertStored({ id: tempId, text: 'retrying' });
    const mutation = messages.mutation<any, { text: string }, { id: string; text: string }, { id: string; text: string }>('retry', {
      document: mutationDocument,
      result: 'messageSend',
      dedupe: false,
      optimistic: {
        model: messages,
        existingTempId: () => tempId,
        build: input => ({ id: 'ignored', text: input.text }),
        selectServerNode: data => data.messageSend?.message
      }
    });

    await expect(mutation.run({ text: 'retrying' })).rejects.toThrow('network failed');
    expect(messages.get(tempId)).toEqual({ id: tempId, text: 'retrying' });
    expect(messages.getAll()).toHaveLength(1);
    await expect(mutation.run({ text: 'retrying' })).resolves.toEqual({ messageSend: { message: { id: 'server-1', text: 'sent' } } });
    expect(messages.get(tempId)).toBeUndefined();
    expect(messages.get('server-1')).toEqual({ id: 'server-1', text: 'sent' });
    expect(messages.getAll()).toHaveLength(1);
  });

  it('E. does not dedupe parallel mutations when the dedupe key is null', async () => {
    let calls = 0;
    configure({
      mutation: async () => {
        calls += 1;
        return { data: { messageSend: {} } };
      }
    });
    const mutation = defineCommand<any, { value: string }, { id: string }, { id: string }>('parallel', {
      document: mutationDocument,
      result: 'messageSend',
      dedupe: { key: () => null }
    });

    await Promise.all([mutation.run({ value: 'first' }), mutation.run({ value: 'second' })]);

    expect(calls).toBe(2);
  });

  it('F. returns nullish relation defaults with stable empty hasMany output', () => {
    configure();
    let chats: any;
    let messages: any;
    chats = defineModel({
      id: 'parity-related-chats',
      name: 'ParityRelatedChatModel',
      fields: { title: f.str() },
      relations: () => ({ messages: hasMany(messages, { foreignKey: 'chatId' }) })
    });
    messages = defineModel({
      id: 'parity-related-messages',
      name: 'ParityRelatedMessageModel',
      fields: { chatId: f.str(), text: f.str() },
      relations: () => ({ chat: belongsTo(chats, { foreignKey: 'chatId' }) })
    });
    const parent = renderHook(() => messages.use.related(null, 'chat'), undefined);
    const children = renderHook(() => chats.use.related(null, 'messages'), undefined);
    const empty = children.current;

    expect(parent.current).toBeUndefined();
    expect(empty).toEqual([]);
    children.rerender(undefined);
    expect(children.current).toBe(empty);
    parent.unmount();
    children.unmount();
  });

  it('G. keeps hasMany children when dependent destroy is omitted', () => {
    configure();
    let parents: any;
    let children: any;
    parents = defineModel({
      id: 'parity-parents',
      name: 'ParityParentModel',
      fields: { name: f.str() },
      relations: () => ({ children: hasMany(children, { foreignKey: 'parentId' }) })
    });
    children = defineModel({ id: 'parity-children', name: 'ParityChildModel', fields: { parentId: f.str() } });
    parents.insertStored({ id: 'parent-1', name: 'parent' });
    children.insertStored({ id: 'child-1', parentId: 'parent-1' });

    parents.destroy('parent-1');

    expect(children.get('child-1')).toEqual({ id: 'child-1', parentId: 'parent-1' });
  });

  it('H. starts a query after its enabled scope flips to true', async () => {
    let calls = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    configureDb({
      storage: createStorage(),
      queryClient: client,
      transport: {
        query: async () => {
          calls += 1;
          return { data: { items: [{ id: 'row-1', name: 'fetched' }] } };
        },
        mutation: async () => ({ data: {} })
      } as any
    });
    const items = defineModel({ id: 'parity-enabled-items', name: 'ParityEnabledItemModel', fields: { name: f.str() }, scopes: { list: scope({ sort: 'server-order' }) } });
    const query = items.query<any, any, { enabled: boolean }, any>('enabled', {
      document: queryDocument,
      select: data => data.items,
      into: items.scopes.list,
      enabled: value => value.enabled
    });
    const view = renderQuery(client, value => query.use(value), { enabled: false });

    await act(async () => { await Promise.resolve(); });
    expect(calls).toBe(0);
    view.rerender({ enabled: true });
    await waitFor(() => calls === 1);
    view.unmount();
  });

  it('I. exposes local rows as ready while a query is disabled', async () => {
    let calls = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    configureDb({
      storage: createStorage(),
      queryClient: client,
      transport: {
        query: async () => {
          calls += 1;
          return { data: { items: [] } };
        },
        mutation: async () => ({ data: {} })
      } as any
    });
    const items = defineModel({ id: 'parity-disabled-items', name: 'ParityDisabledItemModel', fields: { name: f.str() }, scopes: { list: scope({ sort: 'server-order' }) } });
    const scopeValue = { list: 'local' };
    items.scopes.list.__apply?.(scopeValue, [{ id: 'row-1', name: 'local' }], 'complete');
    const query = items.query<any, any, typeof scopeValue, any>('disabled', {
      document: queryDocument,
      select: data => data.items,
      into: items.scopes.list,
      enabled: () => false
    });
    const view = renderQuery(client, value => query.use(value), scopeValue);

    await act(async () => { await Promise.resolve(); });
    expect(view.current.loadingState.phase).toBe('ready');
    expect(view.current.data).toEqual([{ id: 'row-1', name: 'local' }]);
    expect(calls).toBe(0);
    view.unmount();
  });
});
