import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  configureDb,
  createCollectionBinding,
  devClearAllDataAndState,
  mergeInitialSyncContract,
  modelDetailRequest,
  runDbInfiniteQueryDirect,
  runDbQueryDirect,
  stableSerialize,
  useDbInfiniteRequest,
  useDbSingleRequest
} from '../index';
import { deriveDbKey } from '../core/deriveDbKey';
import { setDbExtractSink } from '../core/extract';
import type { BaseQueryCollection, BaseQueryResult, ConnectionWithNodes, DbGraphQLDocument, DbRequestInfiniteConfig, DbRequestSingleConfig, PageInfoInput } from '../types';
import { createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);

type Equal<TActual, TExpected> = (<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type ResultData<T> = T extends { data: infer TData } ? TData : never;

declare const typedTodoModel: ReturnType<typeof createTodoModel>;
declare const typedTodoQuery: DbGraphQLDocument<{ todo: Todo }, { id: string }>;
declare const untypedRead: BaseQueryCollection;

const inferModelBackedSingleRequest = () =>
  useDbSingleRequest({
    query: typedTodoQuery,
    vars: { id: 'todo-1' },
    select: data => data.todo,
    sync: { model: typedTodoModel, contract: 'typed' },
    read: { model: typedTodoModel, id: 'todo-1' }
  });
type _ModelBackedSingleRequestData = Expect<Equal<ResultData<ReturnType<typeof inferModelBackedSingleRequest>>, Todo | null | undefined>>;

const inferExplicitSingleRequest = () =>
  useDbSingleRequest<{ todo: Todo }, { title: string }, Todo, { id: string }>({
    query: typedTodoQuery,
    vars: { id: 'todo-1' },
    select: data => data.todo,
    sync: { model: typedTodoModel, contract: 'explicit' },
    read: { model: typedTodoModel, id: 'todo-1' }
  });
type _ExplicitSingleRequestData = Expect<Equal<ResultData<ReturnType<typeof inferExplicitSingleRequest>>, { title: string } | undefined>>;

const inferMappedSingleRequest = () =>
  useDbSingleRequest({
    key: ['mapped-single-request'],
    query: typedTodoQuery,
    vars: { id: 'todo-1' },
    select: data => data.todo,
    map: selected => selected.title
  });
type _MappedSingleRequestData = Expect<Equal<ResultData<ReturnType<typeof inferMappedSingleRequest>>, string | undefined>>;

const inferUntypedSingleRequest = () =>
  useDbSingleRequest({
    query: typedTodoQuery,
    vars: { id: 'todo-1' },
    read: untypedRead
  });
type _UntypedSingleRequestResult = Expect<Equal<ReturnType<typeof inferUntypedSingleRequest>, BaseQueryResult<unknown>>>;

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

const renderQueryHook = <T,>(queryClient: QueryClient, read: () => T) => {
  let current!: T;
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = () => {
    current = read();
    return null;
  };

  act(() => {
    renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Harness)));
  });

  return {
    get current() {
      return current;
    },
    async flush() {
      await act(async () => {
        await flush();
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
      queryClient.clear();
    }
  };
};

type TodoConnectionResponse = {
  todos: ConnectionWithNodes & {
    pageInfo?: PageInfoInput | null;
  };
};

describe('request config derivation', () => {
  afterEach(async () => {
    setDbExtractSink(() => {});
    await flush();
    devClearAllDataAndState();
  });

  it('builds model detail requests with derived key, vars, read, sync, and enabled fields', () => {
    const model = createTodoModel({ id: 'detail-builder' });
    const config = modelDetailRequest<{ todo: Todo }, Todo, Todo, Todo | undefined, { id: string | null | undefined }>(model, {
      query: document<{ todo: Todo }, { id: string | null | undefined }>('TodoDetail'),
      id: 'todo-1',
      select: data => data.todo,
      contract: 'details',
      staleTime: 123,
      gcTime: 456
    });
    const typedConfig: DbRequestSingleConfig<{ todo: Todo }, Todo | undefined, Todo, { id: string | null | undefined }> = config;

    expect(typedConfig.key).toEqual(deriveDbKey(model, { id: 'todo-1' }));
    expect(typedConfig.vars).toEqual({ id: 'todo-1' });
    expect(typedConfig.sync).toEqual({ model, contract: 'details' });
    expect(typedConfig.read).toEqual({ model, id: 'todo-1' });
    expect(typedConfig.enabled).toBe(true);
    expect(typedConfig.staleTime).toBe(123);
    expect(typedConfig.gcTime).toBe(456);

    expect(
      modelDetailRequest(model, {
        query: document<{ todo: Todo }>('DisabledDetail'),
        id: null,
        select: data => data.todo,
        enabled: true
      }).enabled
    ).toBe(false);
    expect(
      modelDetailRequest(model, {
        query: document<{ todo: Todo }>('CallerDisabledDetail'),
        id: 'todo-1',
        select: data => data.todo,
        enabled: false
      }).enabled
    ).toBe(false);
  });

  it('supports no-read detail requests with custom vars for uuid-like lookups', async () => {
    const model = createTodoModel({ id: 'detail-by-uuid' });
    const query = jest.fn(async op => {
      expect((op as { variables?: unknown }).variables).toEqual({ id: 'uuid-1', first: 1 });
      return {
        data: {
          user: {
            id: 'server-user-1',
            title: 'Server user',
            listId: null,
            done: false,
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        }
      };
    });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({ query })
    });

    const config = modelDetailRequest<{ user: Todo }, Todo, Todo, Todo, { id: string | null | undefined; first: number }>(model, {
      query: document<{ user: Todo }, { id: string | null | undefined; first: number }>('TodoByUuid'),
      id: 'uuid-1',
      select: data => data.user,
      vars: id => ({ id, first: 1 }),
      contract: 'deepLink',
      read: false,
      enabled: id => id === 'uuid-1'
    });

    expect(config.key).toEqual(deriveDbKey(model, { id: 'uuid-1' }));
    expect(config.read).toBeUndefined();
    expect(config.enabled).toBe(true);

    await expect(runDbQueryDirect(config)).resolves.toMatchObject({ id: 'server-user-1', title: 'Server user' });
    expect(model.get('server-user-1')?.title).toBe('Server user');
  });

  it('runs direct single requests with explicit select, extract, sync, and map', async () => {
    const model = createTodoModel({ id: 'direct-selected-query' });
    const sink = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async op => {
          expect((op as { variables?: unknown }).variables).toEqual({ id: 'todo-selected' });
          return {
            data: {
              todo: { id: 'todo-selected', title: 'Selected', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' },
              ignored: { id: 'todo-ignored', title: 'Ignored' }
            }
          };
        }
      }),
      extract: { sink }
    });

    await expect(
      runDbQueryDirect<{ todo: Todo; ignored: { id: string; title: string } }, string, Todo, { id: string }>({
        query: document<{ todo: Todo; ignored: { id: string; title: string } }, { id: string }>('DirectSelectedTodo'),
        vars: { id: 'todo-selected' },
        select: data => data.todo,
        sync: { model, contract: 'direct-selected' },
        extract: ({ selected }) => ({ todos: [selected] }),
        extractSource: 'selectedQuery',
        map: selected => selected.title
      })
    ).resolves.toBe('Selected');

    expect(model.get('todo-selected')?.title).toBe('Selected');
    expect(model.get('todo-ignored')).toBeUndefined();
    expect(sink).toHaveBeenCalledWith({ todos: [expect.objectContaining({ id: 'todo-selected' })] }, 'selectedQuery');
  });

  it('uses the full response as the direct single request default selection', async () => {
    const sync = jest.fn();
    const sink = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async () => ({
          data: {
            todo: { id: 'todo-identity', title: 'Identity', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
          }
        })
      }),
      extract: { sink }
    });

    await expect(
      runDbQueryDirect<{ todo: Todo }, { id: string }, { todo: Todo }>({
        query: document<{ todo: Todo }>('DirectIdentityTodo'),
        sync,
        extract: ({ data, selected }) => ({ sameReference: data === selected }),
        map: selected => ({ id: selected.todo.id }),
        key: ['hook-only-key'],
        enabled: false,
        staleTime: 1
      })
    ).resolves.toEqual({ id: 'todo-identity' });

    expect(sync).toHaveBeenCalledWith({
      todo: { id: 'todo-identity', title: 'Identity', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
    });
    expect(sink).toHaveBeenCalledWith({ sameReference: true }, 'query');
  });

  it('derives infinite request vars, key, read filter, and freshness scope from scope', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'scope-derived-filter' });
    const binding = createCollectionBinding(model, { scopeMap: { listId: 'listId' } });
    const calls: Array<unknown> = [];
    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({
        query: async op => {
          calls.push((op as { variables?: unknown }).variables);
          return {
            data: {
              todos: {
                nodes: [{ id: 'todo-inbox', title: 'Scoped inbox', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
                pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
              }
            }
          };
        }
      })
    });
    const typedConfig: DbRequestInfiniteConfig<TodoConnectionResponse, Todo, { first: number; listId?: string }> = {
      query: document<TodoConnectionResponse, { first: number; listId?: string }>('ScopedTodoList'),
      selectPage: data => data.todos,
      vars: { first: 10 },
      scope: { listId: 'inbox' },
      read: binding
    };

    const hook = renderQueryHook(queryClient, () => useDbInfiniteRequest(typedConfig));

    await hook.flush();
    await hook.flush();

    expect(calls).toEqual([{ listId: 'inbox', first: 10 }]);
    expect(queryClient.getQueryCache().find({ queryKey: deriveDbKey(model, { listId: 'inbox' }), exact: true })).toBeDefined();
    expect(hook.current.data.map(item => item.id)).toEqual(['todo-inbox']);
    expect(model.getFetchState({ listId: 'inbox' })).toMatchObject({ empty: false });

    hook.unmount();
  });

  it('keeps explicit filter and vars ahead of derived scope', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'scope-explicit-wins' });
    const binding = createCollectionBinding(model, { scopeMap: { listId: 'listId' } });
    const calls: Array<unknown> = [];
    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({
        query: async op => {
          calls.push((op as { variables?: unknown }).variables);
          return {
            data: {
              todos: {
                nodes: [{ id: 'todo-filter', title: 'Filter wins', listId: 'filter-value', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
                pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
              }
            }
          };
        }
      })
    });

    const hook = renderQueryHook(queryClient, () =>
      useDbInfiniteRequest({
        query: document<TodoConnectionResponse>('ExplicitScopeOverrides'),
        selectPage: data => data.todos,
        vars: { listId: 'vars-value' },
        scope: { listId: 'scope-value' },
        filter: () => ({ listId: 'filter-value' }),
        read: binding
      })
    );

    await hook.flush();
    await hook.flush();

    expect(calls).toEqual([{ listId: 'vars-value' }]);
    expect(queryClient.getQueryCache().find({ queryKey: deriveDbKey(model, { listId: 'filter-value' }), exact: true })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: ['db', 'scope-explicit-wins', stableSerialize({ listId: 'scope-value' })], exact: true })).toBeUndefined();
    expect(hook.current.data.map(item => item.id)).toEqual(['todo-filter']);
    expect(model.getFetchState({ listId: 'filter-value' })).toMatchObject({ empty: false });

    hook.unmount();
  });

  it('uses replace for default initial infinite writes and merge for default loadMore writes', async () => {
    const applyServerData = jest.fn();
    const read = {
      applyServerData,
      useData: () => [],
      shouldSkipInitialFetch: () => false,
      markFetched: jest.fn()
    };
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async () => ({
          data: {
            todos: {
              nodes: [{ id: 'todo-contract', title: 'Contract', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
            }
          }
        })
      })
    });

    const baseConfig: DbRequestInfiniteConfig<TodoConnectionResponse, Todo> = {
      query: document<TodoConnectionResponse>('DefaultContractTodos'),
      selectPage: data => data.todos,
      filter: () => ({ listId: 'inbox' }),
      read
    };

    await runDbInfiniteQueryDirect(baseConfig);
    await runDbInfiniteQueryDirect(baseConfig, 'cursor-1');

    expect(applyServerData).toHaveBeenNthCalledWith(1, expect.any(Array), { mode: 'replace', source: 'initial', scope: { listId: 'inbox' } });
    expect(applyServerData).toHaveBeenNthCalledWith(2, expect.any(Array), { mode: 'merge', source: 'loadMore', scope: { listId: 'inbox' } });
  });

  it('exports a merge-initial infinite sync resolver while explicit configs still win', async () => {
    const applyServerData = jest.fn();
    const read = {
      applyServerData,
      useData: () => [],
      shouldSkipInitialFetch: () => false,
      markFetched: jest.fn()
    };
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async () => ({
          data: {
            todos: {
              nodes: [{ id: 'todo-merge-contract', title: 'Merge Contract', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
            }
          }
        })
      })
    });

    const mergeConfig: DbRequestInfiniteConfig<TodoConnectionResponse, Todo> = {
      query: document<TodoConnectionResponse>('MergeInitialContractTodos'),
      selectPage: data => data.todos,
      filter: () => ({ listId: 'inbox' }),
      resolveSyncContract: mergeInitialSyncContract,
      read
    };

    await runDbInfiniteQueryDirect(mergeConfig);
    await runDbInfiniteQueryDirect(mergeConfig, 'cursor-1');

    expect(applyServerData).toHaveBeenNthCalledWith(1, expect.any(Array), { mode: 'merge', source: 'initial', scope: { listId: 'inbox' } });
    expect(applyServerData).toHaveBeenNthCalledWith(2, expect.any(Array), { mode: 'merge', source: 'loadMore', scope: { listId: 'inbox' } });

    const explicitConfig: DbRequestInfiniteConfig<TodoConnectionResponse, Todo> = {
      ...mergeConfig,
      resolveSyncContract: ({ scope }) => ({ mode: 'replace', source: 'explicit', scope })
    };
    await runDbInfiniteQueryDirect(explicitConfig);

    expect(applyServerData).toHaveBeenNthCalledWith(3, expect.any(Array), { mode: 'replace', source: 'explicit', scope: { listId: 'inbox' } });
  });

  it('passes custom infinite request extract sources to the extract sink', async () => {
    const sink = jest.fn();
    const read = {
      applyServerData: jest.fn(),
      useData: () => [],
      shouldSkipInitialFetch: () => false,
      markFetched: jest.fn()
    };
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async () => ({
          data: {
            todos: {
              nodes: [{ id: 'todo-extract-source', title: 'Extract source', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
            }
          }
        })
      }),
      extract: { sink }
    });

    await runDbInfiniteQueryDirect<TodoConnectionResponse, Todo>({
      query: document<TodoConnectionResponse>('ExtractSourceTodos'),
      selectPage: data => data.todos,
      extract: ({ nodes }) => ({ todos: nodes }),
      extractSource: 'pagedQuery',
      read
    });

    expect(sink).toHaveBeenCalledWith({ todos: [expect.objectContaining({ id: 'todo-extract-source' })] }, 'pagedQuery');
  });

  it('passes globalIndex to patchNode across pages and resets it on an initial fetch', async () => {
    const seen: Array<{ id: string; index: number; globalIndex: number; pageParam?: string }> = [];
    const applyServerData = jest.fn();
    const read = {
      applyServerData,
      useData: () => [],
      shouldSkipInitialFetch: () => false,
      markFetched: jest.fn()
    };
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async op => {
          const pageParam = (op as { variables?: { after?: string } }).variables?.after;
          const suffix = pageParam === 'cursor-1' ? 'load' : 'initial';
          return {
            data: {
              todos: {
                nodes: [
                  { id: `${suffix}-1`, title: `${suffix} 1`, listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' },
                  { id: `${suffix}-2`, title: `${suffix} 2`, listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
                ],
                pageInfo: { hasNextPage: pageParam !== 'cursor-1', hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
              }
            }
          };
        }
      })
    });

    const config: DbRequestInfiniteConfig<TodoConnectionResponse, Todo> = {
      query: document<TodoConnectionResponse>('GlobalIndexTodos'),
      selectPage: data => data.todos,
      getPageVars: after => ({ after }),
      patchNode: (node, context) => {
        seen.push({ id: node.id, index: context.index, globalIndex: context.globalIndex, pageParam: context.pageParam });
        return { title: `${context.globalIndex}:${node.title}` };
      },
      read
    };

    await runDbInfiniteQueryDirect(config);
    await runDbInfiniteQueryDirect(config, 'cursor-1');
    await runDbInfiniteQueryDirect(config);

    expect(seen).toEqual([
      { id: 'initial-1', index: 0, globalIndex: 0, pageParam: undefined },
      { id: 'initial-2', index: 1, globalIndex: 1, pageParam: undefined },
      { id: 'load-1', index: 0, globalIndex: 2, pageParam: 'cursor-1' },
      { id: 'load-2', index: 1, globalIndex: 3, pageParam: 'cursor-1' },
      { id: 'initial-1', index: 0, globalIndex: 0, pageParam: undefined },
      { id: 'initial-2', index: 1, globalIndex: 1, pageParam: undefined }
    ]);
    expect(applyServerData.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ id: 'load-1', title: '2:load 1' }),
      expect.objectContaining({ id: 'load-2', title: '3:load 2' })
    ]);
  });
});
