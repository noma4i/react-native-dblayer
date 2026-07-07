import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  configureDb,
  devClearAllDataAndState,
  mergeOptimisticSnapshot,
  runDbMutationDirect,
  setDbExtractSink,
  setDbMutationExtractResolver,
  useCommand,
  useDbMutation
} from '../index';
import type { DbGraphQLDocument, DbMutationConfig } from '../types';
import { createTodoFieldsModel, createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);
type TodoMutationInput = { title: string; tempId?: string | null };

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
    queryClient,
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

  it('derives mutation key and log prefix from resultField when omitted', async () => {
    const debug = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      logger: { debug, error: jest.fn() },
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-derived', title: 'Server derived', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
          }
        })
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('DerivedMutationMetadata'),
        resultField: 'todoCreate'
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'Derived' });
    });

    expect(debug).toHaveBeenCalledWith('TodoCreate', 'mutationFn start');
    expect(hook.queryClient.getMutationCache().getAll()[0]?.options.mutationKey).toEqual(['todoCreate']);

    hook.unmount();
  });

  it('keeps explicit mutation key and log prefix ahead of derived metadata', async () => {
    const debug = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      logger: { debug, error: jest.fn() },
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-explicit', title: 'Server explicit', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
          }
        })
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('ExplicitMutationMetadata'),
        resultField: 'todoCreate',
        key: () => ['explicit-key'],
        logPrefix: 'ExplicitLog'
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'Explicit' });
    });

    expect(debug).toHaveBeenCalledWith('ExplicitLog', 'mutationFn start');
    expect(hook.queryClient.getMutationCache().getAll()[0]?.options.mutationKey).toEqual(['explicit-key']);

    hook.unmount();
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

  it('inserts and commits rows through the declarative optimistic preset', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    const transportResult = deferred<{ data: Record<string, Todo> }>();
    const commitContext = jest.fn((_data: Todo | null, _input: TodoMutationInput, context: { tempId: string | null; optimisticRow: Stored | null }) => {
      expect(context.tempId).toMatch(/^temp-todo-/);
      expect(context.optimisticRow?.title).toBe('Optimistic preset');
    });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: () => transportResult.promise
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, void, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoPreset'),
        resultField: 'todoCreate',
        key: () => ['create-todo-preset'],
        logPrefix: 'create-todo-preset',
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data
        },
        onCommit: commitContext
      })
    );

    act(() => {
      hook.current.mutate({ title: 'Optimistic preset' });
    });
    await hook.flush();

    const optimisticRow = model.getAll()[0]!;
    expect(optimisticRow.id).toMatch(/^temp-todo-/);
    expect(optimisticRow.title).toBe('Optimistic preset');

    await act(async () => {
      transportResult.resolve({
        data: {
          todoCreate: { id: 'server-preset', title: 'Server preset', listId: null, done: false, updatedAt: '2026-01-02T00:00:00.000Z' }
        }
      });
      await transportResult.promise;
    });
    await hook.flush();

    expect(model.get(optimisticRow.id)).toBeUndefined();
    expect(model.get('server-preset')?.title).toBe('Server preset');
    expect(model.getAll()).toHaveLength(1);
    expect(commitContext).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  it('skips declarative optimistic insertion when input carries a temp id', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    const existing = model.buildStored({ id: 'temp-existing', title: 'Existing upload' });
    model.insertStored(existing);
    const insertSpy = jest.spyOn(model, 'insertStored');
    const buildStored = jest.fn(({ input, tempId }: { input: TodoMutationInput; tempId: string }) => model.buildStored({ id: tempId, title: input.title }));
    const transportResult = deferred<{ data: Record<string, Todo> }>();
    const commitContext = jest.fn((_data: Todo | null, _input: TodoMutationInput, context: { tempId: string | null; optimisticRow: Stored | null }) => {
      expect(context.tempId).toBe('temp-existing');
      expect(context.optimisticRow).toEqual(expect.objectContaining({ id: existing.id, title: existing.title }));
    });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: () => transportResult.promise
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, void, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('RetryTodoPreset'),
        resultField: 'todoRetry',
        key: () => ['retry-todo-preset'],
        logPrefix: 'retry-todo-preset',
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored,
          selectServerNode: data => data
        },
        onCommit: commitContext
      })
    );

    act(() => {
      hook.current.mutate({ title: 'Retry upload', tempId: 'temp-existing' });
    });
    await hook.flush();

    expect(buildStored).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(model.get('temp-existing')?.title).toBe('Existing upload');

    await act(async () => {
      transportResult.resolve({
        data: {
          todoRetry: { id: 'server-retry', title: 'Server retry', listId: null, done: false, updatedAt: '2026-01-03T00:00:00.000Z' }
        }
      });
      await transportResult.promise;
    });
    await hook.flush();

    expect(model.get('temp-existing')).toBeUndefined();
    expect(model.get('server-retry')?.title).toBe('Server retry');
    expect(model.getAll()).toHaveLength(1);
    expect(commitContext).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  it('falls back to applyServerData when the declarative optimistic preset skips insertion', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    const buildStored = jest.fn(() => null);
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-fallback', title: 'Server fallback', listId: null, done: false, updatedAt: '2026-01-04T00:00:00.000Z' }
          }
        })
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, void, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoFallbackPreset'),
        resultField: 'todoCreate',
        key: () => ['create-todo-fallback-preset'],
        logPrefix: 'create-todo-fallback-preset',
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored,
          selectServerNode: data => data
        }
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'No optimistic row' });
    });

    expect(buildStored).toHaveBeenCalledTimes(1);
    expect(model.get('server-fallback')?.title).toBe('Server fallback');
    expect(model.getAll()).toHaveLength(1);

    hook.unmount();
  });

  it('merges optimistic snapshots with server-wins-unless-empty semantics and custom mergers', () => {
    const optimistic = {
      id: 'temp-1',
      body: 'optimistic body',
      mediaUrl: 'file://local.mov',
      replyTo: { id: 'reply-1', body: 'local reply', media: { width: 320 } },
      localOnly: 'keep'
    };
    const server = {
      id: 'server-1',
      body: '',
      mediaUrl: null,
      replyTo: { id: 'reply-1', body: '', media: { height: 180 } },
      serverOnly: 'keep'
    };

    expect(
      mergeOptimisticSnapshot(optimistic, server, {
        mergers: {
          replyTo: (optimisticValue, serverValue) => mergeOptimisticSnapshot(optimisticValue as object, serverValue as object)
        }
      })
    ).toEqual({
      id: 'server-1',
      body: 'optimistic body',
      mediaUrl: 'file://local.mov',
      replyTo: { id: 'reply-1', body: 'local reply', media: { height: 180 } },
      localOnly: 'keep',
      serverOnly: 'keep'
    });

    expect(mergeOptimisticSnapshot({ body: 'local', mediaUrl: 'file://local.mov' }, { body: '', mediaUrl: null, id: 'server' }, { fields: ['body', 'mediaUrl'] })).toEqual({
      id: 'server',
      body: 'local',
      mediaUrl: 'file://local.mov'
    });
  });

  it('applies preserveOnCommit before replacing the optimistic row', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-preserve', title: '', listId: null, done: false, updatedAt: '2026-01-04T00:00:00.000Z' }
          }
        })
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, void, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoPreservePreset'),
        resultField: 'todoCreate',
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data,
          preserveOnCommit: { fields: ['title'] }
        }
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'Optimistic title' });
    });

    expect(model.get('server-preserve')?.title).toBe('Optimistic title');
    expect(model.getAll()).toHaveLength(1);

    hook.unmount();
  });

  it('applies preserveOnCommit before the applyServerData fallback write', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-preserve-fallback', title: 'Server fallback', listId: null, done: false, updatedAt: '2026-01-04T00:00:00.000Z' }
          }
        })
      })
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, void, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoPreserveFallbackPreset'),
        resultField: 'todoCreate',
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored: () => null,
          selectServerNode: data => data,
          preserveOnCommit: serverNode => ({ ...serverNode, title: 'Transformed fallback' })
        }
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'No optimistic row' });
    });

    expect(model.get('server-preserve-fallback')?.title).toBe('Transformed fallback');
    expect(model.getAll()).toHaveLength(1);

    hook.unmount();
  });

  it('hydrates optimisticRow for direct retry commits with an existing temp id', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    const existing = model.buildStored({ id: 'temp-direct', title: 'Existing direct upload' });
    model.insertStored(existing);
    const onCommit = jest.fn((_data: Todo | null, _input: TodoMutationInput, context: { tempId: string | null; optimisticRow: Stored | null }) => {
      expect(context.tempId).toBe('temp-direct');
      expect(context.optimisticRow).toEqual(expect.objectContaining({ id: 'temp-direct', title: 'Existing direct upload' }));
    });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-direct', title: '', listId: null, done: false, updatedAt: '2026-01-04T00:00:00.000Z' }
          }
        })
      })
    });

    await runDbMutationDirect<Todo, TodoMutationInput, { tempId: string | null; optimisticRow?: Stored | null }, Stored, Todo>(
      {
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoDirectPreservePreset'),
        resultField: 'todoCreate',
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data,
          preserveOnCommit: { fields: ['title'] }
        },
        onCommit
      },
      { title: 'Retry direct', tempId: 'temp-direct' }
    );

    expect(model.get('temp-direct')).toBeUndefined();
    expect(model.get('server-direct')?.title).toBe('Existing direct upload');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('runs manual commit side effects after the declarative optimistic commit and keeps extract handling', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    const resolver = jest.fn(() => ({ users: [{ id: 'u1' }] }));
    const sink = jest.fn();
    const manualCommit = jest.fn((_data: Todo | null, _input: TodoMutationInput, context: { tracked: boolean; tempId: string | null }) => {
      expect(context.tracked).toBe(true);
      expect(context.tempId).toMatch(/^temp-todo-/);
      expect(model.get('server-side-effect')?.title).toBe('Server side effect');
    });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-side-effect', title: 'Server side effect', listId: null, done: false, updatedAt: '2026-01-05T00:00:00.000Z' }
          }
        })
      }),
      extract: { sink, mutationResolver: resolver }
    });

    const extractSpec = { todo: true };
    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, { tracked: boolean }, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoPresetWithCommit'),
        resultField: 'todoCreate',
        key: () => ['create-todo-preset-with-commit'],
        logPrefix: 'create-todo-preset-with-commit',
        extract: extractSpec,
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data
        },
        onMutate: () => ({ tracked: true }),
        onCommit: manualCommit
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'Side effect' });
    });

    expect(resolver).toHaveBeenCalledWith(extractSpec, expect.objectContaining({ id: 'server-side-effect' }));
    expect(sink).toHaveBeenCalledWith({ users: [{ id: 'u1' }] }, 'mutation');
    expect(manualCommit).toHaveBeenCalledTimes(1);

    hook.unmount();
  });

  it('types the declarative optimistic config section', () => {
    expect(true).toBe(true);

    if (false) {
      const model = null as unknown as ReturnType<typeof createTodoFieldsModel>;
      type Stored = ReturnType<typeof model.getAll>[number];

      const validConfig: DbMutationConfig<Todo, TodoMutationInput, void, Stored, Todo> = {
        mutation: document<Record<string, Todo>, { input: unknown }>('TypedTodoPreset'),
        resultField: 'todoCreate',
        optimistic: {
          model,
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data,
          preserveOnCommit: {
            fields: ['title'],
            mergers: {
              title: (optimisticValue, serverValue) => serverValue ?? optimisticValue
            }
          }
        },
        onCommit: (_data: Todo | null, _input: TodoMutationInput, context: { tempId: string | null; optimisticRow: Stored | null }) => {
          const tempId: string | null = context.tempId;
          const optimisticRow: Stored | null = context.optimisticRow;
          expect({ tempId, optimisticRow }).toBeDefined();
        },
        track: {
          start: input => ({ name: 'typed-start', payload: { title: input.title } }),
          success: (_data: Todo | null, _input: TodoMutationInput, context: { tempId: string | null; optimisticRow: Stored | null }) => {
            const tempId: string | null = context.tempId;
            const optimisticRow: Stored | null = context.optimisticRow;
            return { name: 'typed-success', payload: { tempId, optimisticTitle: optimisticRow?.title } };
          },
          error: (error, input) => ({ name: 'typed-error', payload: { title: input.title, error: error.message } })
        }
      };

      const extraContextConfig: DbMutationConfig<Todo, TodoMutationInput, { tracked: boolean }, Stored, Todo> = {
        mutation: document<Record<string, Todo>, { input: unknown }>('TypedTodoPresetExtraContext'),
        resultField: 'todoCreate',
        key: () => ['typed-todo-preset-extra-context'],
        logPrefix: 'typed-todo-preset-extra-context',
        optimistic: {
          model,
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data
        },
        onMutate: () => ({ tracked: true }),
        onCommit: (_data: Todo | null, _input: TodoMutationInput, context: { tracked: boolean; tempId: string | null; optimisticRow: Stored | null }) => {
          const tracked: boolean = context.tracked;
          const tempId: string | null = context.tempId;
          const optimisticRow: Stored | null = context.optimisticRow;
          expect({ tracked, tempId, optimisticRow }).toBeDefined();
        }
      };

      const wrongStoredConfig: DbMutationConfig<Todo, TodoMutationInput, void, Stored, Todo> = {
        mutation: document<Record<string, Todo>, { input: unknown }>('TypedTodoPresetWrongStored'),
        resultField: 'todoCreate',
        key: () => ['typed-todo-preset-wrong-stored'],
        logPrefix: 'typed-todo-preset-wrong-stored',
        optimistic: {
          model,
          // @ts-expect-error buildStored must return the model stored row shape
          buildStored: () => ({ id: 'temp-wrong' }),
          selectServerNode: data => data
        }
      };

      const wrongServerNodeConfig: DbMutationConfig<Todo, TodoMutationInput, void, Stored, Todo> = {
        mutation: document<Record<string, Todo>, { input: unknown }>('TypedTodoPresetWrongServerNode'),
        resultField: 'todoCreate',
        key: () => ['typed-todo-preset-wrong-server-node'],
        logPrefix: 'typed-todo-preset-wrong-server-node',
        optimistic: {
          model,
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          // @ts-expect-error selectServerNode must return the declared server node shape
          selectServerNode: () => ({ id: 'server-wrong' })
        }
      };

      const wrongTrackNameConfig: DbMutationConfig<Todo, TodoMutationInput, void, Stored, Todo> = {
        mutation: document<Record<string, Todo>, { input: unknown }>('TypedTodoPresetWrongTrackName'),
        resultField: 'todoCreate',
        key: () => ['typed-todo-preset-wrong-track-name'],
        logPrefix: 'typed-todo-preset-wrong-track-name',
        optimistic: {
          model,
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data
        },
        track: {
          // @ts-expect-error track event name must be a string
          start: () => ({ name: 1 })
        }
      };

      const wrongTrackPayloadConfig: DbMutationConfig<Todo, TodoMutationInput, void, Stored, Todo> = {
        mutation: document<Record<string, Todo>, { input: unknown }>('TypedTodoPresetWrongTrackPayload'),
        resultField: 'todoCreate',
        key: () => ['typed-todo-preset-wrong-track-payload'],
        logPrefix: 'typed-todo-preset-wrong-track-payload',
        optimistic: {
          model,
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data
        },
        track: {
          // @ts-expect-error track payload must be a record
          success: () => ({ name: 'bad-payload', payload: 'bad' })
        }
      };

      expect({ validConfig, extraContextConfig, wrongStoredConfig, wrongServerNodeConfig, wrongTrackNameConfig, wrongTrackPayloadConfig }).toBeDefined();
    }
  });

  it('emits declarative track start and success around optimistic preset commits', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    const order: string[] = [];
    const trackSink = jest.fn(event => {
      order.push(`track:${event.name}`);
    });
    const resolver = jest.fn(() => {
      order.push('extract');
      return { users: [] };
    });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-track', title: 'Server tracked', listId: null, done: false, updatedAt: '2026-01-06T00:00:00.000Z' }
          }
        })
      }),
      trackSink,
      extract: { sink: jest.fn(), mutationResolver: resolver }
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, void, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoTrackedPreset'),
        resultField: 'todoCreate',
        key: () => ['create-todo-tracked-preset'],
        logPrefix: 'create-todo-tracked-preset',
        extract: { todo: true },
        optimistic: {
          model,
          tempIdPrefix: 'todo',
          buildStored: ({ input, tempId }) => {
            order.push('buildStored');
            return model.buildStored({ id: tempId, title: input.title });
          },
          selectServerNode: data => data
        },
        onCommit: () => {
          expect(model.get('server-track')?.title).toBe('Server tracked');
          order.push('onCommit');
        },
        track: {
          start: input => ({ name: 'todo-start', payload: { title: input.title } }),
          success: (_data: Todo | null, _input: TodoMutationInput, context: { tempId: string | null }) => ({ name: 'todo-success', payload: { tempId: context.tempId } })
        }
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'Tracked optimistic' });
    });

    expect(order).toEqual(['track:todo-start', 'buildStored', 'extract', 'onCommit', 'track:todo-success']);
    expect(trackSink).toHaveBeenNthCalledWith(1, { name: 'todo-start', payload: { title: 'Tracked optimistic' } });
    expect(trackSink).toHaveBeenNthCalledWith(2, { name: 'todo-success', payload: { tempId: expect.stringMatching(/^temp-todo-/) } });

    hook.unmount();
  });

  it('emits declarative track error after onError and before rethrow', async () => {
    const order: string[] = [];
    const trackSink = jest.fn(event => {
      order.push(`track:${event.name}`);
    });
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => {
          throw new Error('tracked failure');
        }
      }),
      trackSink
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoTrackedFailure'),
        resultField: 'todoCreate',
        key: () => ['create-todo-tracked-failure'],
        logPrefix: 'create-todo-tracked-failure',
        onError: () => {
          order.push('onError');
        },
        track: {
          start: input => ({ name: 'todo-start', payload: { title: input.title } }),
          error: (error, input) => ({ name: 'todo-error', payload: { title: input.title, error: error.message } })
        }
      })
    );

    await act(async () => {
      await expect(hook.current.mutateAsync({ title: 'Tracked failure' })).rejects.toThrow('tracked failure');
    });

    expect(order).toEqual(['track:todo-start', 'onError', 'track:todo-error']);
    expect(trackSink).toHaveBeenNthCalledWith(2, { name: 'todo-error', payload: { title: 'Tracked failure', error: 'tracked failure' } });

    hook.unmount();
  });

  it('skips null track events and keeps no-sink track sections silent', async () => {
    const skipSink = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({ data: { todoCreate: { id: 'skip-track', title: 'Skip', listId: null, done: false, updatedAt: null } } })
      }),
      trackSink: skipSink
    });

    const skipHook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('SkipTrackEvents'),
        resultField: 'todoCreate',
        key: () => ['skip-track-events'],
        logPrefix: 'skip-track-events',
        track: {
          start: () => null,
          success: () => undefined
        }
      })
    );

    await act(async () => {
      await skipHook.current.mutateAsync({ title: 'Skip' });
    });
    expect(skipSink).not.toHaveBeenCalled();
    skipHook.unmount();

    const start = jest.fn(() => ({ name: 'unconfigured-start' }));
    const success = jest.fn(() => ({ name: 'unconfigured-success' }));
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({ data: { todoCreate: { id: 'no-sink', title: 'No sink', listId: null, done: false, updatedAt: null } } })
      })
    });

    const noSinkHook = renderQueryHook(() =>
      useDbMutation<Todo, { title: string }>({
        mutation: document<Record<string, Todo>, { input: unknown }>('NoSinkTrackEvents'),
        resultField: 'todoCreate',
        key: () => ['no-sink-track-events'],
        logPrefix: 'no-sink-track-events',
        track: { start, success }
      })
    );

    await act(async () => {
      await noSinkHook.current.mutateAsync({ title: 'No sink' });
    });
    expect(start).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();

    noSinkHook.unmount();
  });

  it('swallows throwing track sinks without breaking the mutation', async () => {
    const model = createTodoFieldsModel();
    type Stored = ReturnType<typeof model.getAll>[number];
    const debug = jest.fn();
    configureDb({
      storage: inMemoryStorageAdapter(),
      logger: { debug, error: jest.fn() },
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'server-throwing-track', title: 'Server throwing track', listId: null, done: false, updatedAt: '2026-01-07T00:00:00.000Z' }
          }
        })
      }),
      trackSink: () => {
        throw new Error('sink failed');
      }
    });

    const hook = renderQueryHook(() =>
      useDbMutation<Todo, TodoMutationInput, void, Stored, Todo>({
        mutation: document<Record<string, Todo>, { input: unknown }>('ThrowingTrackSink'),
        resultField: 'todoCreate',
        key: () => ['throwing-track-sink'],
        logPrefix: 'throwing-track-sink',
        optimistic: {
          model,
          buildStored: ({ input, tempId }) => model.buildStored({ id: tempId, title: input.title }),
          selectServerNode: data => data
        },
        track: {
          start: () => ({ name: 'throwing-start' }),
          success: () => ({ name: 'throwing-success' })
        }
      })
    );

    await act(async () => {
      await hook.current.mutateAsync({ title: 'Throwing sink' });
    });

    expect(model.get('server-throwing-track')?.title).toBe('Server throwing track');
    expect(debug).toHaveBeenCalledWith('throwing-track-sink', 'track sink failed', 'start', expect.any(Error));
    expect(debug).toHaveBeenCalledWith('throwing-track-sink', 'track sink failed', 'success', expect.any(Error));

    hook.unmount();
  });

  it('tracks patch and destroy mutation variants', async () => {
    const model = createTodoModel();
    model.insertStored({ id: 'track-patch', title: 'Original', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    model.insertStored({ id: 'track-destroy', title: 'Destroy', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    const events: Array<{ name: string; payload?: Record<string, unknown> }> = [];
    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({ data: { noop: null } })
      }),
      trackSink: event => {
        events.push(event);
      }
    });

    const patchHook = renderQueryHook(() =>
      useDbMutation<null, { id: string; title: string }, void, Todo>({
        method: 'patch',
        mutation: document<Record<string, null>, { input: unknown }>('TrackedPatchTodo'),
        resultField: 'noop',
        key: () => ['tracked-patch-todo'],
        logPrefix: 'tracked-patch-todo',
        model,
        selectId: input => input.id,
        selectPatch: input => ({ title: input.title }),
        track: {
          start: input => ({ name: 'patch-start', payload: { id: input.id } }),
          success: (_result, input) => ({ name: 'patch-success', payload: { id: input.id } })
        }
      })
    );
    const destroyHook = renderQueryHook(() =>
      useDbMutation<null, { id: string }>({
        method: 'destroy',
        mutation: document<Record<string, null>, { input: unknown }>('TrackedDestroyTodo'),
        resultField: 'noop',
        key: () => ['tracked-destroy-todo'],
        logPrefix: 'tracked-destroy-todo',
        model,
        selectId: input => input.id,
        track: {
          start: input => ({ name: 'destroy-start', payload: { id: input.id } }),
          success: (_result, input) => ({ name: 'destroy-success', payload: { id: input.id } })
        }
      })
    );

    await act(async () => {
      await patchHook.current.mutateAsync({ id: 'track-patch', title: 'Patched' });
      await destroyHook.current.mutateAsync({ id: 'track-destroy' });
    });

    expect(model.get('track-patch')?.title).toBe('Patched');
    expect(model.get('track-destroy')).toBeUndefined();
    expect(events).toEqual([
      { name: 'patch-start', payload: { id: 'track-patch' } },
      { name: 'patch-success', payload: { id: 'track-patch' } },
      { name: 'destroy-start', payload: { id: 'track-destroy' } },
      { name: 'destroy-success', payload: { id: 'track-destroy' } }
    ]);

    patchHook.unmount();
    destroyHook.unmount();
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
