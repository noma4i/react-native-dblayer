import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  configureDb,
  createCollectionBinding,
  devClearAllDataAndState,
  invalidateDbRequests,
  invalidateModel,
  resetDbQueryRuntime,
  stableSerialize,
  useDbInfiniteRequest,
  useDbSingleRequest
} from '../index';
import { deriveDbKey } from '../core/deriveDbKey';
import { refetchDbRequests } from '../core/queryClient';
import type { ConnectionWithNodes, DbGraphQLDocument, PageInfoInput } from '../types';
import { createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);

const renderQueryHook = <T,>(queryClient: QueryClient, read: () => T, options?: { clearOnUnmount?: boolean }) => {
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

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

describe('request keys and imperative query runtime', () => {
  afterEach(async () => {
    await flush();
    devClearAllDataAndState();
  });

  it('derives stable db keys from model id and normalized scope', () => {
    const model = createTodoModel({ id: 'key-stability' });

    expect(deriveDbKey(model)).toEqual(['db', 'key-stability']);
    expect(deriveDbKey(model, { listId: 'inbox', done: undefined })).toEqual(['db', 'key-stability', stableSerialize({ listId: 'inbox' })]);
    expect(deriveDbKey(model, { done: undefined })).toEqual(['db', 'key-stability']);
  });

  it('invalidates, refetches, and resets requests through configured QueryClient', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'imperative-requests' });
    let version = 0;
    const query = jest.fn(async () => {
      version += 1;
      return {
        data: {
          todo: {
            id: 'todo-1',
            title: `Todo ${version}`,
            listId: 'inbox',
            done: false,
            updatedAt: `2026-01-0${version}T00:00:00.000Z`
          }
        }
      };
    });

    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({ query })
    });

    const hook = renderQueryHook(queryClient, () =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        query: document<{ todo: Todo }>('TodoById'),
        select: data => data.todo,
        sync: { model, contract: 'todo' },
        read: { model, id: 'todo-1' },
        staleTime: Infinity
      })
    );

    await hook.flush();
    await hook.flush();

    expect(query).toHaveBeenCalledTimes(1);
    expect(model.get('todo-1')?.title).toBe('Todo 1');
    expect(queryClient.getQueryCache().find({ queryKey: deriveDbKey(model, { id: 'todo-1' }), exact: true })).toBeDefined();

    await act(async () => {
      await invalidateDbRequests(deriveDbKey(model));
    });
    await hook.flush();

    expect(query).toHaveBeenCalledTimes(2);
    expect(model.get('todo-1')?.title).toBe('Todo 2');

    await act(async () => {
      await refetchDbRequests(deriveDbKey(model));
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(model.get('todo-1')?.title).toBe('Todo 3');

    await resetDbQueryRuntime();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);

    hook.unmount();
  });

  it('no-ops imperative APIs without a configured QueryClient and logs package errors', async () => {
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({
      storage: inMemoryStorageAdapter(),
      logger,
      transport: mockTransport({})
    });

    await invalidateDbRequests(['db', 'missing']);
    await refetchDbRequests(['db', 'missing']);
    await resetDbQueryRuntime();

    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it('clears fetch-state before invalidating model keys through the configured QueryClient', () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'invalidate-model' });
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    const logger = { debug: jest.fn(), error: jest.fn() };

    configureDb({
      storage: inMemoryStorageAdapter(),
      logger,
      queryClient,
      transport: mockTransport({})
    });
    model.markFetched({ listId: 'inbox' }, { empty: false });
    model.markFetched({ listId: 'archive' }, { empty: false });

    model.invalidate({ listId: 'inbox' });

    expect(model.getFetchState({ listId: 'inbox' })).toBeNull();
    expect(model.getFetchState({ listId: 'archive' })).toMatchObject({ empty: false });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: deriveDbKey(model, { listId: 'inbox' }) });
    expect(logger.debug).toHaveBeenCalledWith('db', 'freshness:clear', expect.objectContaining({ scope: { listId: 'inbox' } }));

    model.invalidate();

    expect(model.getFetchState({ listId: 'archive' })).toBeNull();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: deriveDbKey(model) });
    expect(logger.debug).toHaveBeenCalledWith('db', 'freshness:clear', expect.objectContaining({ scope: undefined }));
  });

  it('reenables a mounted gate-disabled request after invalidateModel clears fetch-state', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'invalidate-mounted', staleTime: Infinity });
    const logger = { debug: jest.fn(), error: jest.fn() };
    const query = jest.fn(async () => ({
      data: {
        todo: {
          id: 'todo-1',
          title: 'Fetched after invalidate',
          listId: 'inbox',
          done: false,
          updatedAt: '2026-01-02T00:00:00.000Z'
        }
      }
    }));

    configureDb({
      storage: inMemoryStorageAdapter(),
      logger,
      queryClient,
      transport: mockTransport({ query })
    });
    model.insertStored({ id: 'todo-1', title: 'Cached', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    model.markFetched({ id: 'todo-1' }, { empty: false });

    const hook = renderQueryHook(queryClient, () =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        query: document<{ todo: Todo }>('InvalidateMountedTodo'),
        select: data => data.todo,
        sync: { model, contract: 'todo' },
        read: { model, id: 'todo-1' },
        staleTime: Infinity
      })
    );

    await hook.flush();
    expect(query).not.toHaveBeenCalled();
    expect(hook.current.data?.title).toBe('Cached');
    expect(logger.debug).toHaveBeenCalledWith('db', 'freshness:skip', expect.objectContaining({ empty: false }));

    act(() => {
      model.markFetched({ id: 'todo-1' }, { empty: false });
    });
    await hook.flush();
    expect(query).not.toHaveBeenCalled();

    act(() => {
      model.invalidate({ id: 'todo-1' });
    });
    await hook.flush();
    await hook.flush();

    expect(query).toHaveBeenCalledTimes(1);
    expect(model.get('todo-1')?.title).toBe('Fetched after invalidate');

    hook.unmount();
  });

  it('keeps explicit single request keys ahead of derived model keys', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'explicit-single-key' });

    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({
        query: async () => ({
          data: {
            todo: { id: 'todo-1', title: 'Explicit', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
          }
        })
      })
    });

    const hook = renderQueryHook(queryClient, () =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        key: ['explicit', 'todo-1'],
        query: document<{ todo: Todo }>('ExplicitKeyTodo'),
        select: data => data.todo,
        sync: { model, contract: 'todo' },
        read: { model, id: 'todo-1' }
      })
    );

    await hook.flush();
    await hook.flush();

    expect(queryClient.getQueryCache().find({ queryKey: ['explicit', 'todo-1'], exact: true })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: deriveDbKey(model, { id: 'todo-1' }), exact: true })).toBeUndefined();

    hook.unmount();
  });

  it('derives different single-request keys for different vars on the same model', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'vars-key-distinct' });
    const query = jest.fn(async (operation: unknown) => {
      const id = (operation as { variables?: { id?: string } }).variables?.id ?? 'unknown';
      return {
        data: {
          todo: { id, title: `Todo ${id}`, listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
        }
      };
    });

    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({ query })
    });

    const makeHook = (id: string) =>
      renderQueryHook(queryClient, () =>
        useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
          query: document<{ todo: Todo }, { id: string }>('TodoByVars'),
          vars: { id },
          select: data => data.todo,
          sync: { model, contract: 'todo' }
        })
      );

    const hookA = makeHook('todo-a');
    const hookB = makeHook('todo-b');
    await hookA.flush();
    await hookB.flush();

    expect(query).toHaveBeenCalledTimes(2);

    const baseKey = deriveDbKey(model);
    expect(queryClient.getQueryCache().find({ queryKey: [...baseKey, stableSerialize({ id: 'todo-a' })], exact: true })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: [...baseKey, stableSerialize({ id: 'todo-b' })], exact: true })).toBeDefined();
    expect(model.get('todo-a')?.title).toBe('Todo todo-a');
    expect(model.get('todo-b')?.title).toBe('Todo todo-b');

    hookA.unmount();
    hookB.unmount();
  });

  it('derives the same single-request key for identical vars (stability)', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'vars-key-stable', staleTime: Infinity });
    const query = jest.fn(async () => ({
      data: { todo: { id: 'todo-stable', title: 'Stable', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' } }
    }));

    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({ query })
    });

    const makeHook = () =>
      renderQueryHook(queryClient, () =>
        useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
          query: document<{ todo: Todo }, { id: string }>('TodoByStableVars'),
          vars: { id: 'todo-stable' },
          select: data => data.todo,
          sync: { model, contract: 'todo' },
          staleTime: Infinity
        })
      );

    // Two concurrently mounted instances with identical vars must resolve to the same derived key -
    // React Query dedupes them into a single in-flight request instead of two independent fetches.
    const hookA = makeHook();
    const hookB = makeHook();
    await hookA.flush();
    await hookB.flush();

    expect(query).toHaveBeenCalledTimes(1);

    const baseKey = deriveDbKey(model);
    expect(queryClient.getQueryCache().getAll().filter(entry => entry.queryKey[0] === baseKey[0] && entry.queryKey[1] === baseKey[1])).toHaveLength(1);

    hookA.unmount();
    hookB.unmount();
  });

  it('keeps an explicit single-request key unaffected by vars', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'vars-key-explicit' });

    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({
        query: async () => ({
          data: { todo: { id: 'todo-explicit', title: 'Explicit with vars', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' } }
        })
      })
    });

    const hook = renderQueryHook(queryClient, () =>
      useDbSingleRequest<{ todo: Todo }, Todo, Todo>({
        key: ['explicit', 'todo-explicit'],
        query: document<{ todo: Todo }, { id: string }>('ExplicitKeyWithVarsTodo'),
        vars: { id: 'todo-explicit' },
        select: data => data.todo,
        sync: { model, contract: 'todo' }
      })
    );

    await hook.flush();
    await hook.flush();

    expect(queryClient.getQueryCache().find({ queryKey: ['explicit', 'todo-explicit'], exact: true })).toBeDefined();
    expect(queryClient.getQueryCache().find({ queryKey: [...deriveDbKey(model), stableSerialize({ id: 'todo-explicit' })], exact: true })).toBeUndefined();

    hook.unmount();
  });

  it('derives infinite request keys from collection binding scope vocabulary', async () => {
    const queryClient = createQueryClient();
    const model = createTodoModel({ id: 'infinite-scope-key' });
    const binding = createCollectionBinding(model, { scopeMap: { listId: 'listId' } });

    configureDb({
      storage: inMemoryStorageAdapter(),
      queryClient,
      transport: mockTransport({
        query: async () => ({
          data: {
            todos: {
              nodes: [{ id: 'todo-1', title: 'Scoped', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'cursor-1', endCursor: 'cursor-1' }
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

    const hook = renderQueryHook(queryClient, () =>
      useDbInfiniteRequest({
        query: document<TodoConnectionResponse>('ScopedInfiniteTodos'),
        selectPage: data => data.todos,
        read: binding,
        filter: () => ({ listId: 'inbox', ignored: 'not-in-scope-map' })
      })
    );

    await hook.flush();
    await hook.flush();

    expect(queryClient.getQueryCache().find({ queryKey: deriveDbKey(model, { listId: 'inbox' }), exact: true })).toBeDefined();
    expect(model.getFetchState({ listId: 'inbox' })).toMatchObject({ empty: false });

    hook.unmount();
  });
});
