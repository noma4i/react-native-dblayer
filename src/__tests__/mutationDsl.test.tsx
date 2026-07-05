import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  configureDb,
  devClearAllDataAndState,
  setDbExtractSink,
  setDbMutationExtractResolver,
  useCommand,
  useDbMutation
} from '../index';
import type { DbGraphQLDocument } from '../types';
import { createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const renderQueryHook = <T,>(read: () => T) => {
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

describe('mutation DSL runtime', () => {
  afterEach(async () => {
    setDbExtractSink(() => {});
    setDbMutationExtractResolver(spec => spec);
    await flush();
    devClearAllDataAndState();
  });

  it('commits optimistic rows into server rows on a successful mutation', async () => {
    const model = createTodoModel();
    const transportResult = deferred<{ data: Record<string, Todo> }>();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: () => transportResult.promise
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }, { tempId: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodo'),
        resultField: 'todoCreate',
        key: () => ['create-todo'],
        logPrefix: 'create-todo',
        mapInput: input => input,
        onMutate: input => {
          const tempId = 'temp-todo';
          model.insertStored({ id: tempId, title: input.title, listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
          return { tempId };
        },
        onCommit: (data, _input, context) => {
          if (data) {
            model.replaceRaw(context.tempId, data);
          }
        }
      })
    );

    act(() => {
      hook.current.mutate({ title: 'Optimistic' });
    });
    await hook.flush();

    expect(model.get('temp-todo')?.title).toBe('Optimistic');

    await act(async () => {
      transportResult.resolve({
        data: {
          todoCreate: { id: 'server-todo', title: 'Server', listId: null, done: false, updatedAt: '2026-01-02T00:00:00.000Z' }
        }
      });
      await transportResult.promise;
    });
    await hook.flush();

    expect(model.get('temp-todo')).toBeUndefined();
    expect(model.get('server-todo')?.title).toBe('Server');

    hook.unmount();
  });

  it('rolls back optimistic writes when the mutation transport rejects', async () => {
    const model = createTodoModel();
    const transportResult = deferred<{ data: Record<string, Todo> }>();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: () => transportResult.promise
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }, { tempId: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoFailure'),
        resultField: 'todoCreate',
        key: () => ['create-todo-failure'],
        logPrefix: 'create-todo-failure',
        onMutate: input => {
          const tempId = 'temp-fail';
          model.insertStored({ id: tempId, title: input.title, listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
          return { tempId };
        }
      })
    );

    const promise = hook.current.mutateAsync({ title: 'Will rollback' });
    await hook.flush();

    expect(model.get('temp-fail')?.title).toBe('Will rollback');

    await act(async () => {
      transportResult.reject(new Error('network failed'));
      await expect(promise).rejects.toThrow('network failed');
    });
    await hook.flush();

    expect(model.get('temp-fail')).toBeUndefined();

    hook.unmount();
  });

  it('applies patch and destroy optimistic mutation variants', async () => {
    const model = createTodoModel();
    model.insertStored({ id: 'patch-me', title: 'Original', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    model.insertStored({ id: 'destroy-me', title: 'Destroy', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({ data: { noop: null } })
      })
    });

    const patchHook = renderQueryHook(() =>
      useDbMutation<null, { id: string; title: string }, void, Todo>({
        method: 'patch',
        mutation: document<Record<string, null>, { input: unknown }>('PatchTodo'),
        resultField: 'noop',
        key: () => ['patch-todo'],
        logPrefix: 'patch-todo',
        model,
        selectId: input => input.id,
        selectPatch: input => ({ title: input.title, updatedAt: '2026-01-02T00:00:00.000Z' })
      })
    );
    const destroyHook = renderQueryHook(() =>
      useDbMutation<null, { id: string }>({
        method: 'destroy',
        mutation: document<Record<string, null>, { input: unknown }>('DestroyTodo'),
        resultField: 'noop',
        key: () => ['destroy-todo'],
        logPrefix: 'destroy-todo',
        model,
        selectId: input => input.id
      })
    );

    await act(async () => {
      await patchHook.current.mutateAsync({ id: 'patch-me', title: 'Patched' });
      await destroyHook.current.mutateAsync({ id: 'destroy-me' });
    });

    expect(model.get('patch-me')?.title).toBe('Patched');
    expect(model.get('destroy-me')).toBeUndefined();

    patchHook.unmount();
    destroyHook.unmount();
  });

  it('runs command mutations through the injected GraphQL transport', async () => {
    const mutationSpy = jest.fn(async () => ({ data: { commandRun: { ok: true } } }));
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({ mutation: mutationSpy })
    });

    const hook = renderQueryHook(() =>
      useCommand<{ ok: boolean }, { id: string }>({
        mutation: document<Record<string, { ok: boolean }>, { input: unknown }>('RunCommand'),
        resultField: 'commandRun',
        key: () => ['run-command'],
        logPrefix: 'run-command'
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ id: 'command-1' });
    });

    expect(mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ variables: { input: { id: 'command-1' } } }));

    hook.unmount();
  });

  it('resolves mutation extract specs before passing them to the extract sink', async () => {
    const resolver = jest.fn(() => ({ users: [{ id: 'u1' }] }));
    const sink = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-todo', title: 'Server', listId: null, done: false, updatedAt: '2026-01-02T00:00:00.000Z' }
          }
        })
      }),
      extract: { sink, mutationResolver: resolver }
    });

    const extractSpec = { todo: true };
    const hook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoWithExtract'),
        resultField: 'todoCreate',
        key: () => ['create-todo-extract'],
        logPrefix: 'create-todo-extract',
        extract: extractSpec
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'Extract' });
    });

    expect(resolver).toHaveBeenCalledWith(extractSpec, expect.objectContaining({ id: 'server-todo' }));
    expect(sink).toHaveBeenCalledWith({ users: [{ id: 'u1' }] }, 'mutation');

    hook.unmount();
  });
});
