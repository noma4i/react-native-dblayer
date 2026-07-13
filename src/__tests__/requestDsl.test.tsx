import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureDb, createCollectionBinding, devClearAllDataAndState, useDbInfiniteRequest, useDbSingleRequest } from '../index';
import { setDbExtractSink } from '../core/extract';
import type { CollectionReadConfig, ConnectionWithNodes, DbGraphQLDocument, PageInfoInput } from '../types';
import { createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);

type HookResult<T> = {
  current: T;
  flush: () => Promise<void>;
  rerender: () => void;
  unmount: () => void;
};

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

const renderQueryHook = <T,>(read: () => T, options?: { queryClient?: QueryClient; clearOnUnmount?: boolean }): HookResult<T> => {
  const queryClient = options?.queryClient ?? createQueryClient();
  let current!: T;
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = () => {
    current = read();
    return null;
  };

  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    );
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
    rerender() {
      act(() => {
        renderer.update(
          <QueryClientProvider client={queryClient}>
            <Harness />
          </QueryClientProvider>
        );
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
      if (options?.clearOnUnmount !== false) {
        queryClient.clear();
      }
    }
  };
};

describe('request DSL runtime', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    setDbExtractSink(() => {});
    await flush();
    devClearAllDataAndState();
  });

  it('runs a single GraphQL request, syncs into a model, reads reactively, and applies query extract output', async () => {
    const model = createTodoModel();
    const sink = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async () => ({
          data: {
            user: {
              id: 'todo-1',
              title: 'Synced todo',
              listId: 'inbox',
              done: false,
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          }
        })
      }),
      extract: { sink }
    });

    const hook = renderQueryHook(() =>
      useDbSingleRequest<{ user: Todo }, Todo, Todo>({
        query: document<{ user: Todo }>('SingleTodo'),
        key: ['single-todo', 'todo-1'],
        select: data => data.user,
        sync: { model, contract: 'single' },
        extract: ({ selected }) => ({ selected }),
        read: { model, id: 'todo-1' },
        staleTime: 1000
      })
    );

    expect(hook.current.loadingState.phase).toBe('initial_loading');

    await hook.flush();
    await hook.flush();

    expect(model.get('todo-1')?.title).toBe('Synced todo');
    expect(hook.current.data?.title).toBe('Synced todo');
    expect(hook.current.loadingState.hasData).toBe(true);
    expect(sink).toHaveBeenCalledWith(
      {
        selected: expect.objectContaining({ id: 'todo-1' })
      },
      'query'
    );

    hook.unmount();
  });

  it('runs an infinite GraphQL request and writes paged connection nodes into the collection binding', async () => {
    const model = createTodoModel();
    const binding = createCollectionBinding(model);
    const calls: Array<unknown> = [];
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async op => {
          const variables = (op as { variables?: { after?: string } }).variables;
          calls.push(variables);
          if (variables?.after === 'cursor-1') {
            return {
              data: {
                todos: {
                  nodes: [{ id: 'todo-2', title: 'Second page', listId: 'inbox', done: false, updatedAt: '2026-01-02T00:00:00.000Z' }],
                  pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-2', endCursor: 'cursor-2' }
                }
              }
            };
          }
          return {
            data: {
              todos: {
                nodes: [{ id: 'todo-1', title: 'First page', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
                pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
              }
            }
          };
        }
      })
    });

    type TodoConnectionResponse = {
      todos: ConnectionWithNodes & {
        pageInfo?: PageInfoInput | null;
      };
    };

    const hook = renderQueryHook(() =>
      useDbInfiniteRequest({
        query: document<TodoConnectionResponse>('InfiniteTodos'),
        key: ['infinite-todos'],
        selectPage: data => data.todos,
        read: binding,
        staleTime: 1000
      })
    );

    await hook.flush();
    await hook.flush();

    expect(model.getAll().map(item => item.id)).toEqual(['todo-1']);
    expect(hook.current.data.map(item => item.id)).toEqual(['todo-1']);
    expect(hook.current.hasNextPage).toBe(true);

    act(() => {
      hook.current.loadMore();
    });
    await hook.flush();
    await hook.flush();

    expect(model.getAll().map(item => item.id).sort()).toEqual(['todo-1', 'todo-2']);
    expect(hook.current.data.map(item => item.id).sort()).toEqual(['todo-1', 'todo-2']);
    expect(calls).toContainEqual({ after: 'cursor-1' });

    hook.unmount();
  });

  it('orders collection binding reads with a comparator and rejects mixed ordering config', async () => {
    const model = createTodoModel();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({})
    });
    model.insertStored({ id: 'todo-b', title: 'Beta', listId: 'group-1', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    model.insertStored({ id: 'todo-c', title: 'Gamma', listId: 'group-2', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    model.insertStored({ id: 'todo-a', title: 'Alpha', listId: 'group-1', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });

    const binding = createCollectionBinding(model, {
      comparator: (left, right) => {
        const groupCompare = (left.listId ?? '').localeCompare(right.listId ?? '');
        return groupCompare !== 0 ? groupCompare : left.title.localeCompare(right.title);
      }
    });
    const hook = renderQueryHook(() => binding.useData());

    await hook.flush();

    expect(hook.current.map(item => item.id)).toEqual(['todo-a', 'todo-b', 'todo-c']);
    const firstSortedRows = hook.current;

    hook.rerender();
    expect(hook.current).toBe(firstSortedRows);

    model.insertStored({ id: 'todo-d', title: 'Delta', listId: 'group-2', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    await hook.flush();
    expect(hook.current).not.toBe(firstSortedRows);
    expect(hook.current.map(item => item.id)).toEqual(['todo-a', 'todo-b', 'todo-d', 'todo-c']);

    const invalidConfig = { sortField: 'title', comparator: () => 0 } as unknown as CollectionReadConfig<Todo>;
    expect(() => createCollectionBinding(model, invalidConfig)).toThrow('createCollectionBinding received both `sortField` and `comparator`');

    hook.unmount();
  });

  it('lets collection bindings override useData with scoped rows', async () => {
    const model = createTodoModel();
    const contexts: Array<{ scope: unknown; rows: string[] }> = [];
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({})
    });
    model.insertStored({ id: 'todo-inbox', title: 'Inbox', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    model.insertStored({ id: 'todo-other', title: 'Other', listId: 'other', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });

    const binding = createCollectionBinding<Todo, { id: string; label: string; scopeListId: string | null }>(model, {
      scopeMap: { listId: 'listId' },
      useData: ({ rows, scope, empty }) => {
        contexts.push({ scope, rows: rows.map(row => row.id) });
        if (rows.length === 0) return empty;
        return rows.map(row => ({ id: row.id, label: row.title, scopeListId: (scope?.listId as string | undefined) ?? null }));
      }
    });
    const hook = renderQueryHook(() => binding.useData({ listId: 'inbox' }));

    await hook.flush();

    expect(hook.current).toEqual([{ id: 'todo-inbox', label: 'Inbox', scopeListId: 'inbox' }]);
    expect(contexts.at(-1)).toEqual({ scope: { listId: 'inbox' }, rows: ['todo-inbox'] });

    hook.unmount();
  });

  it('keeps nullish scoped binding reads empty and counts explicit nullish filters as zero', async () => {
    const model = createTodoModel();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({})
    });
    model.insertStored({ id: 'todo-inbox', title: 'Inbox', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    const binding = createCollectionBinding(model, { scopeMap: { listId: 'listId' } });
    const hook = renderQueryHook(() => ({
      rows: binding.useData(null),
      modelNullCount: model.count(null),
      modelUndefinedCount: model.count(undefined),
      bindingNullCount: binding.count(null),
      bindingUndefinedCount: binding.count(undefined),
      modelAllCount: model.count(),
      bindingAllCount: binding.count()
    }));

    const firstRows = hook.current.rows;

    act(() => {
      model.insertStored({ id: 'todo-later', title: 'Later', listId: 'inbox', done: false, updatedAt: '2026-01-02T00:00:00.000Z' });
    });
    await hook.flush();

    expect(hook.current.rows).toBe(firstRows);
    expect(hook.current.rows).toEqual([]);
    expect(hook.current.modelNullCount).toBe(0);
    expect(hook.current.modelUndefinedCount).toBe(0);
    expect(hook.current.bindingNullCount).toBe(0);
    expect(hook.current.bindingUndefinedCount).toBe(0);
    expect(hook.current.modelAllCount).toBe(2);
    expect(hook.current.bindingAllCount).toBe(2);

    hook.unmount();
  });

  it('runs known-empty single requests again on the next mount by default', async () => {
    const model = createTodoModel({ id: 'request-empty-default', staleTime: Infinity });
    const query = jest.fn(async () => ({
      data: {
        todo: null
      }
    }));
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({ query })
    });

    const read = () =>
      useDbSingleRequest<{ todo: Todo | null }, Todo | null, Todo | null>({
        query: document<{ todo: Todo | null }>('KnownEmptyDefaultTodo'),
        key: ['known-empty-default', 'todo-missing'],
        select: data => data.todo,
        read: { model, id: 'todo-missing' },
        staleTime: Infinity
      });

    const first = renderQueryHook(read);
    await first.flush();
    await first.flush();

    expect(query).toHaveBeenCalledTimes(1);
    expect(model.getFetchState({ id: 'todo-missing' })).toMatchObject({ empty: true });
    first.unmount();

    const second = renderQueryHook(read);
    await second.flush();
    await second.flush();

    expect(query).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it('lets request emptyStaleTime opt known-empty single scopes into the skip window', async () => {
    const model = createTodoModel({ id: 'request-empty-override', staleTime: 1000, emptyStaleTime: 0 });
    const query = jest.fn(async () => ({
      data: {
        todo: null
      }
    }));
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({ query })
    });
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    model.markFetched({ id: 'todo-missing' }, { empty: true });
    jest.spyOn(Date, 'now').mockReturnValue(1050);

    const hook = renderQueryHook(() =>
      useDbSingleRequest<{ todo: Todo | null }, Todo | null, Todo | null>({
        query: document<{ todo: Todo | null }>('KnownEmptyOverrideTodo'),
        key: ['known-empty-override', 'todo-missing'],
        select: data => data.todo,
        read: { model, id: 'todo-missing' },
        staleTime: 1000,
        emptyStaleTime: 500
      })
    );
    await hook.flush();

    expect(query).not.toHaveBeenCalled();
    expect(hook.current.data).toBeNull();
    hook.unmount();
  });

  it('passes refetchOnMount through the infinite request path', async () => {
    const model = createTodoModel({ id: 'infinite-refetch-on-mount' });
    const binding = createCollectionBinding(model);
    const queryClient = createQueryClient();
    const query = jest.fn(async () => ({
      data: {
        todos: {
          nodes: [{ id: 'todo-1', title: 'Cached page', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
        }
      }
    }));
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({ query })
    });

    type TodoConnectionResponse = {
      todos: ConnectionWithNodes & {
        pageInfo?: PageInfoInput | null;
      };
    };

    const read = () =>
      useDbInfiniteRequest({
        query: document<TodoConnectionResponse>('InfiniteRefetchOnMountTodos'),
        key: ['infinite-refetch-on-mount'],
        selectPage: data => data.todos,
        read: binding,
        staleTime: 0,
        refetchOnMount: false
      });

    const first = renderQueryHook(read, { queryClient, clearOnUnmount: false });
    await first.flush();
    await first.flush();
    expect(query).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderQueryHook(read, { queryClient, clearOnUnmount: false });
    await second.flush();
    await second.flush();
    expect(query).toHaveBeenCalledTimes(1);
    second.unmount();
    queryClient.clear();
  });

  it('passes maxPages through the infinite request path', async () => {
    const model = createTodoModel({ id: 'infinite-max-pages' });
    const binding = createCollectionBinding(model);
    const queryClient = createQueryClient();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        query: async () => ({
          data: {
            todos: {
              nodes: [],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }
            }
          }
        })
      })
    });

    type TodoConnectionResponse = {
      todos: ConnectionWithNodes & {
        pageInfo?: PageInfoInput | null;
      };
    };

    const hook = renderQueryHook(
      () =>
        useDbInfiniteRequest({
          query: document<TodoConnectionResponse>('InfiniteMaxPages'),
          key: ['infinite-max-pages'],
          selectPage: data => data.todos,
          read: binding,
          maxPages: 3
        }),
      { queryClient }
    );

    await hook.flush();

    expect(queryClient.getQueryCache().find({ queryKey: ['infinite-max-pages'], exact: true })?.options.maxPages).toBe(3);

    hook.unmount();
  });

  it('keeps single-request local data ready while enabled is false without calling queryFn', async () => {
    const model = createTodoModel({ id: 'disabled-single' });
    const query = jest.fn(async () => ({
      data: { todo: { id: 'todo-1', title: 'Todo', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' } }
    }));
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({ query }) });
    model.insertStored({ id: 'todo-1', title: 'Cached Todo', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });

    const hook = renderQueryHook(() =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        query: document<{ todo: Todo }>('DisabledSingleTodo'),
        key: ['disabled-single'],
        select: data => data.todo,
        read: { model, id: 'todo-1' },
        enabled: false
      })
    );

    await hook.flush();

    expect(query).not.toHaveBeenCalled();
    expect(hook.current.loadingState.phase).toBe('ready');
    expect(hook.current.loadingState.showData).toBe(true);
    expect(hook.current.data?.title).toBe('Cached Todo');

    hook.unmount();
  });

  it('marks a disabled single request idle without local data and without calling queryFn', async () => {
    const model = createTodoModel({ id: 'disabled-single-empty' });
    const query = jest.fn(async () => ({
      data: { todo: { id: 'todo-1', title: 'Todo', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' } }
    }));
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({ query }) });

    const hook = renderQueryHook(() =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        query: document<{ todo: Todo }>('DisabledEmptySingleTodo'),
        key: ['disabled-single-empty'],
        select: data => data.todo,
        read: { model, id: 'todo-1' },
        enabled: false
      })
    );

    await hook.flush();

    expect(query).not.toHaveBeenCalled();
    expect(hook.current.loadingState.phase).toBe('idle');
    expect(hook.current.loadingState.showSkeleton).toBe(false);
    expect(hook.current.data).toBeUndefined();

    hook.unmount();
  });

  it('keeps infinite-request local data ready while enabled is false and blocks imperative queryFn fallbacks', async () => {
    const model = createTodoModel({ id: 'disabled-infinite' });
    const binding = createCollectionBinding(model);
    const query = jest.fn(async () => ({
      data: {
        todos: {
          nodes: [{ id: 'todo-1', title: 'Todo', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
          pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
        }
      }
    }));
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({ query }) });
    model.insertStored({ id: 'todo-1', title: 'Cached Todo', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });

    type TodoConnectionResponse = {
      todos: ConnectionWithNodes & {
        pageInfo?: PageInfoInput | null;
      };
    };

    const hook = renderQueryHook(() =>
      useDbInfiniteRequest<TodoConnectionResponse, Todo>({
        query: document<TodoConnectionResponse>('DisabledInfiniteTodos'),
        key: ['disabled-infinite'],
        selectPage: data => data.todos,
        read: binding,
        enabled: false
      })
    );

    await hook.flush();

    expect(query).not.toHaveBeenCalled();
    expect(hook.current.loadingState.phase).toBe('ready');
    expect(hook.current.loadingState.showData).toBe(true);
    expect(hook.current.data.map(item => item.title)).toEqual(['Cached Todo']);

    act(() => {
      hook.current.loadMore();
    });
    await hook.flush();
    expect(query).not.toHaveBeenCalled();

    await act(async () => {
      await hook.current.refetch();
    });
    await hook.flush();
    expect(query).not.toHaveBeenCalled();

    hook.unmount();
  });

  it('marks a disabled infinite request idle without local rows and without calling queryFn', async () => {
    const model = createTodoModel({ id: 'disabled-infinite-empty' });
    const binding = createCollectionBinding(model);
    const query = jest.fn(async () => ({
      data: {
        todos: {
          nodes: [{ id: 'todo-1', title: 'Todo', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }
        }
      }
    }));
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({ query }) });

    type TodoConnectionResponse = {
      todos: ConnectionWithNodes & {
        pageInfo?: PageInfoInput | null;
      };
    };

    const hook = renderQueryHook(() =>
      useDbInfiniteRequest<TodoConnectionResponse, Todo>({
        query: document<TodoConnectionResponse>('DisabledEmptyInfiniteTodos'),
        key: ['disabled-infinite-empty'],
        selectPage: data => data.todos,
        read: binding,
        enabled: false
      })
    );

    await hook.flush();

    expect(query).not.toHaveBeenCalled();
    expect(hook.current.loadingState.phase).toBe('idle');
    expect(hook.current.loadingState.showSkeleton).toBe(false);
    expect(hook.current.data).toEqual([]);

    hook.unmount();
  });

  it('starts fetching once enabled flips from false to true on a mounted single request', async () => {
    const model = createTodoModel({ id: 'flip-enabled-single' });
    const query = jest.fn(async () => ({
      data: { todo: { id: 'todo-1', title: 'Flipped', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' } }
    }));
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({ query }) });

    let enabled = false;
    const hook = renderQueryHook(() =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        query: document<{ todo: Todo }>('FlipEnabledSingleTodo'),
        key: ['flip-enabled-single'],
        select: data => data.todo,
        sync: { model, contract: 'flip-enabled' },
        read: { model, id: 'todo-1' },
        enabled
      })
    );

    await hook.flush();
    expect(query).not.toHaveBeenCalled();
    expect(hook.current.loadingState.phase).toBe('idle');

    enabled = true;
    hook.rerender();
    await hook.flush();
    await hook.flush();

    expect(query).toHaveBeenCalledTimes(1);
    expect(hook.current.data?.title).toBe('Flipped');
    expect(hook.current.loadingState.phase).toBe('ready');

    hook.unmount();
  });

  it('reads freshness state but skips the freshness-gate computation while enabled is false', async () => {
    const model = createTodoModel({ id: 'disabled-freshness-skip', staleTime: 1000 });
    model.markFetched({ id: 'todo-1' }, { empty: false });
    const getFetchStateSpy = jest.spyOn(model, 'getFetchState');
    const shouldSkipInitialFetchSpy = jest.spyOn(model, 'shouldSkipInitialFetch');
    const query = jest.fn(async () => ({
      data: { todo: { id: 'todo-1', title: 'Cached', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' } }
    }));
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({ query }) });

    const hook = renderQueryHook(() =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        query: document<{ todo: Todo }>('DisabledFreshnessSkipTodo'),
        key: ['disabled-freshness-skip'],
        select: data => data.todo,
        read: { model, id: 'todo-1' },
        enabled: false,
        staleTime: 1000
      })
    );

    await hook.flush();

    expect(getFetchStateSpy).toHaveBeenCalled();
    expect(shouldSkipInitialFetchSpy).not.toHaveBeenCalled();

    hook.unmount();
  });

  it('reads collection binding rows for non-nullish null-valued scopes without a disabled channel', async () => {
    const model = createTodoModel();
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({}) });
    model.insertStored({ id: 'todo-a', title: 'Alpha', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });

    const binding = createCollectionBinding(model, { scopeMap: { listId: 'listId' } });
    const hook = renderQueryHook(() => binding.useData({ listId: null }));

    await hook.flush();
    const firstRows = hook.current;

    await hook.flush();

    expect(hook.current).toBe(firstRows);
    expect(hook.current.map(item => item.id)).toEqual(['todo-a']);

    hook.unmount();
  });
});
