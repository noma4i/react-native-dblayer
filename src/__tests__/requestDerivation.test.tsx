import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  configureDb,
  createCollectionBinding,
  deriveDbKey,
  devClearAllDataAndState,
  executeDbSingleRequest,
  modelDetailRequest,
  stableSerialize,
  useDbInfiniteRequest
} from '../index';
import type { ConnectionWithNodes, DbGraphQLDocument, DbRequestInfiniteConfig, DbRequestSingleConfig, PageInfoInput } from '../types';
import { createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);

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

    await expect(executeDbSingleRequest(config)).resolves.toMatchObject({ id: 'server-user-1', title: 'Server user' });
    expect(model.get('server-user-1')?.title).toBe('Server user');
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
    expect(hook.current.items.map(item => item.id)).toEqual(['todo-inbox']);
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
    expect(hook.current.items.map(item => item.id)).toEqual(['todo-filter']);
    expect(model.getFetchState({ listId: 'filter-value' })).toMatchObject({ empty: false });

    hook.unmount();
  });
});
