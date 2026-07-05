import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureDb, createCollectionBinding, devClearAllDataAndState, setDbExtractSink, useDbInfiniteRequest, useDbSingleRequest } from '../index';
import type { ConnectionWithNodes, DbGraphQLDocument, PageInfoInput } from '../types';
import { createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);

type HookResult<T> = {
  current: T;
  flush: () => Promise<void>;
  unmount: () => void;
};

const renderQueryHook = <T,>(read: () => T): HookResult<T> => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
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
      queryClient.clear();
    }
  };
};

describe('request DSL runtime', () => {
  afterEach(async () => {
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
    expect(hook.current.items.map(item => item.id)).toEqual(['todo-1']);
    expect(hook.current.hasNextPage).toBe(true);

    act(() => {
      hook.current.loadMore();
    });
    await hook.flush();
    await hook.flush();

    expect(model.getAll().map(item => item.id).sort()).toEqual(['todo-1', 'todo-2']);
    expect(hook.current.items.map(item => item.id).sort()).toEqual(['todo-1', 'todo-2']);
    expect(calls).toContainEqual({ after: 'cursor-1' });

    hook.unmount();
  });
});
