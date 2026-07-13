import {
  configureDb,
  createCollectionBinding,
  createExtractSink,
  createMutationExtractResolver,
  devClearAllDataAndState,
  liftExtractNodes,
  replaceSyncContract,
  runDbMutationDirect
} from '../index';
import type { ExtractSpecOf } from '../index';
import { setDbExtractSink, setDbMutationExtractResolver } from '../core/extract';
import type { DbGraphQLDocument } from '../types';
import { createTodoModel, inMemoryStorageAdapter, mockTransport, type Todo } from './helpers/testRuntime';

const document = <TData, TVariables = Record<string, unknown>>(name: string): DbGraphQLDocument<TData, TVariables> => ({ kind: 'Document', name } as unknown as DbGraphQLDocument<TData, TVariables>);

describe('extract factories', () => {
  afterEach(() => {
    setDbExtractSink(() => {});
    setDbMutationExtractResolver(spec => spec);
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('resolves boolean and selector mutation presets into non-empty sink payloads', () => {
    const resolver = createMutationExtractResolver<{
      user?: unknown;
      wallet?: unknown;
      message?: unknown;
      extraMessages?: unknown[];
      empty?: unknown[];
    }>({
      user: {
        sink: 'users',
        read: result => result.user
      },
      wallet: {
        sink: 'walletPatch',
        read: 'wallet',
        many: false
      },
      message: {
        sink: 'messages',
        read: result => result.message
      },
      moment: {
        sink: 'moments',
        read: result => result.empty
      }
    });

    expect(
      resolver(
        {
          user: true,
          wallet: true,
          message: (result: { extraMessages?: unknown[] }) => result.extraMessages,
          moment: true
        },
        {
          user: { id: 'user-1' },
          wallet: { balance: 0 },
          message: { id: 'message-1' },
          extraMessages: [{ id: 'message-2' }, null, { id: 'message-3' }],
          empty: []
        }
      )
    ).toEqual({
      users: [{ id: 'user-1' }],
      walletPatch: { balance: 0 },
      messages: [{ id: 'message-2' }, { id: 'message-3' }]
    });
  });

  it('returns undefined for missing specs, null results, and empty resolved payloads', () => {
    const resolver = createMutationExtractResolver<{ user?: unknown }>({
      user: {
        sink: 'users',
        read: result => result.user
      }
    });

    expect(resolver(undefined, { user: { id: 'user-1' } })).toBeUndefined();
    expect(resolver({ user: true }, null)).toBeUndefined();
    expect(resolver({ user: true }, { user: null })).toBeUndefined();
  });

  it('throws when an extract spec contains an unknown key', () => {
    const resolver = createMutationExtractResolver<{ chat?: { id: string } }>({
      chat: { sink: 'chats', read: 'chat', many: false }
    });

    expect(() => resolver({ unknownPreset: true }, { chat: { id: 'chat-1' } })).toThrow(/unknownPreset/);
  });

  it('throws for an unknown extract spec key before checking a null result', () => {
    const resolver = createMutationExtractResolver<{ chat?: { id: string } }>({
      chat: { sink: 'chats', read: 'chat', many: false }
    });

    expect(() => resolver({ unknownPreset: true }, null)).toThrow(/unknownPreset/);
  });

  it('types extract selectors from the mutation result', () => {
    const table = {
      chat: { sink: 'chats', read: 'chat', many: false }
    };
    const spec: ExtractSpecOf<typeof table, { chat: { id: string } }> = {
      chat: result => result.chat
    };

    expect(typeof spec.chat).toBe('function');
  });

  it('merges every existing/incoming shape combination additively when two presets share a sink key', () => {
    type SharedResult = { a?: unknown; b?: unknown };
    const buildResolver = (aValue: unknown, bValue: unknown, aMany: boolean, bMany: boolean) =>
      createMutationExtractResolver<SharedResult>({
        a: { sink: 'shared', read: () => aValue, many: aMany },
        b: { sink: 'shared', read: () => bValue, many: bMany }
      });

    // value + value (the fix): neither preset resolves an array, so the previous implementation
    // silently replaced the first value with the second instead of merging them.
    expect(buildResolver({ tag: 'a' }, { tag: 'b' }, false, false)({ a: true, b: true }, {})).toEqual({
      shared: [{ tag: 'a' }, { tag: 'b' }]
    });

    // array + value
    expect(buildResolver([{ tag: 'a' }], { tag: 'b' }, true, false)({ a: true, b: true }, {})).toEqual({
      shared: [{ tag: 'a' }, { tag: 'b' }]
    });

    // value + array
    expect(buildResolver({ tag: 'a' }, [{ tag: 'b' }], false, true)({ a: true, b: true }, {})).toEqual({
      shared: [{ tag: 'a' }, { tag: 'b' }]
    });

    // array + array
    expect(buildResolver([{ tag: 'a' }], [{ tag: 'b' }], true, true)({ a: true, b: true }, {})).toEqual({
      shared: [{ tag: 'a' }, { tag: 'b' }]
    });
  });

  it('delivers a merged multi-preset sink payload to the sink as one array, declaration order preserved', () => {
    const sharedSink = jest.fn();
    const resolver = createMutationExtractResolver<{ a?: unknown; b?: unknown }>({
      a: { sink: 'shared', read: () => ({ tag: 'a' }), many: false },
      b: { sink: 'shared', read: () => ({ tag: 'b' }), many: false }
    });
    const sink = createExtractSink({ shared: sharedSink });

    const extractResult = resolver({ a: true, b: true }, {});
    sink(extractResult, 'mutation');

    expect(sharedSink).toHaveBeenCalledWith([{ tag: 'a' }, { tag: 'b' }], 'mutation');
  });

  it('resolves true and selector-function presets, skips false/undefined/null silently, and rejects anything else', () => {
    const resolver = createMutationExtractResolver<{ chat?: unknown }>({
      chat: { sink: 'chats', read: () => ({ id: 'chat-1' }), many: false }
    });

    expect(resolver({ chat: true }, {})).toEqual({ chats: { id: 'chat-1' } });
    expect(resolver({ chat: () => ({ id: 'chat-selected' }) }, {})).toEqual({ chats: { id: 'chat-selected' } });

    // `false`/`undefined`/`null` are the recognized "not requested" markers - they skip silently.
    expect(resolver({ chat: false }, {})).toBeUndefined();
    expect(resolver({ chat: undefined }, {})).toBeUndefined();
    expect(resolver({ chat: null }, {})).toBeUndefined();

    // Anything else is a configuration mistake, not a skip - it throws with the sink key name.
    expect(() => resolver({ chat: 'true' }, {})).toThrow(/sink "chats"/);
    expect(() => resolver({ chat: 1 }, {})).toThrow(/sink "chats"/);
  });

  it('applies all model sinks before custom sinks while preserving group declaration order', () => {
    const order: string[] = [];
    const usersModel = {
      applyServerData: jest.fn(() => {
        order.push('users');
        return { merged: 1 };
      })
    };
    const messagesModel = {
      applyServerData: jest.fn(() => {
        order.push('messages');
        return { merged: 1 };
      })
    };
    const walletSink = jest.fn(() => {
      order.push('walletPatch');
    });
    const badgeSink = jest.fn(() => {
      order.push('badgePatch');
    });

    const sink = createExtractSink({
      walletPatch: walletSink,
      users: usersModel,
      badgePatch: badgeSink,
      messages: messagesModel
    });

    sink(
      {
        users: { id: 'user-1' },
        walletPatch: { balance: 12 },
        badgePatch: { count: 3 },
        messages: [{ id: 'message-1' }]
      },
      'mutation'
    );

    expect(usersModel.applyServerData).toHaveBeenCalledWith([{ id: 'user-1' }], { mode: 'merge', source: 'mutation', scope: undefined });
    expect(walletSink).toHaveBeenCalledWith([{ balance: 12 }], 'mutation');
    expect(badgeSink).toHaveBeenCalledWith([{ count: 3 }], 'mutation');
    expect(messagesModel.applyServerData).toHaveBeenCalledWith([{ id: 'message-1' }], { mode: 'merge', source: 'mutation', scope: undefined });
    expect(order).toEqual(['users', 'messages', 'walletPatch', 'badgePatch']);
  });

  it('lets custom sinks patch rows inserted by later-declared model sinks from the same payload', () => {
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({}) });
    const model = createTodoModel();
    const patchLastMessage = jest.fn((payload: unknown[]) => {
      for (const patch of payload as Array<{ id: string; title: string }>) {
        model.patch(patch.id, { title: patch.title });
      }
    });
    const sink = createExtractSink({
      todoLastMessages: patchLastMessage,
      todos: model
    });

    sink(
      {
        todoLastMessages: { id: 'todo-new', title: 'Patched after insert' },
        todos: { id: 'todo-new', title: 'Inserted', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
      },
      'chatSync'
    );

    expect(patchLastMessage).toHaveBeenCalledTimes(1);
    expect(model.get('todo-new')?.title).toBe('Patched after insert');
  });

  it('keeps declaration order for payloads with only model sinks or only custom sinks', () => {
    const modelOrder: string[] = [];
    const usersModel = {
      applyServerData: jest.fn(() => {
        modelOrder.push('users');
        return { merged: 1 };
      })
    };
    const messagesModel = {
      applyServerData: jest.fn(() => {
        modelOrder.push('messages');
        return { merged: 1 };
      })
    };
    createExtractSink({
      users: usersModel,
      messages: messagesModel
    })(
      {
        users: { id: 'user-1' },
        messages: { id: 'message-1' }
      },
      'query'
    );

    const customOrder: string[] = [];
    createExtractSink({
      walletPatch: () => customOrder.push('walletPatch'),
      badgePatch: () => customOrder.push('badgePatch')
    })(
      {
        walletPatch: { balance: 12 },
        badgePatch: { count: 3 }
      },
      'query'
    );

    expect(modelOrder).toEqual(['users', 'messages']);
    expect(customOrder).toEqual(['walletPatch', 'badgePatch']);
  });

  it('uses model sink contracts for scoped replace writes', () => {
    configureDb({ storage: inMemoryStorageAdapter(), transport: mockTransport({}) });
    const model = createTodoModel();
    model.insertStored({ id: 'old-inbox', title: 'Old inbox', listId: 'inbox', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    model.insertStored({ id: 'old-archive', title: 'Old archive', listId: 'archive', done: false, updatedAt: '2026-01-01T00:00:00.000Z' });
    const binding = createCollectionBinding(model, { scopeMap: { listId: 'listId' } });
    const contract = jest.fn((nodes: unknown[], source: string) => replaceSyncContract(source, { listId: (nodes[0] as Todo).listId }));
    const sink = createExtractSink({
      todos: {
        applyServerData: binding.applyServerData,
        contract
      }
    });

    sink(
      {
        todos: { id: 'new-inbox', title: 'New inbox', listId: 'inbox', done: false, updatedAt: '2026-01-02T00:00:00.000Z' }
      },
      'feedSync'
    );

    expect(contract).toHaveBeenCalledWith([expect.objectContaining({ id: 'new-inbox' })], 'feedSync');
    expect(model.get('old-inbox')).toBeUndefined();
    expect(model.get('new-inbox')?.title).toBe('New inbox');
    expect(model.get('old-archive')?.title).toBe('Old archive');
  });

  it('keeps the default merge contract when a model sink omits a contract override', () => {
    const todosModel = {
      applyServerData: jest.fn(() => ({ merged: 1 }))
    };
    const sink = createExtractSink({
      todos: todosModel
    });

    sink(
      {
        todos: { id: 'todo-default-contract' }
      },
      'mutation'
    );

    expect(todosModel.applyServerData).toHaveBeenCalledWith([{ id: 'todo-default-contract' }], { mode: 'merge', source: 'mutation', scope: undefined });
  });

  it('exports node lifting and uses it for custom sinks', () => {
    const walletSink = jest.fn();
    const sink = createExtractSink({ walletPatch: walletSink });

    expect(liftExtractNodes([{ id: 'wallet-1' }, null, undefined, { id: 'wallet-2' }])).toEqual([{ id: 'wallet-1' }, { id: 'wallet-2' }]);

    sink({ walletPatch: [{ balance: 12 }, null, { balance: 13 }] }, 'query');

    expect(walletSink).toHaveBeenCalledWith([{ balance: 12 }, { balance: 13 }], 'query');
  });

  it('runs resolver and sink through configureDb mutation seams', async () => {
    const model = createTodoModel();
    const resolver = createMutationExtractResolver<Todo>({
      todo: {
        sink: 'todos',
        read: result => result
      }
    });
    const sink = createExtractSink({
      todos: model
    });

    configureDb({
      storage: inMemoryStorageAdapter(),
      transport: mockTransport({
        mutation: async () => ({
          data: {
            todoCreate: { id: 'todo-extract', title: 'Extracted todo', listId: null, done: false, updatedAt: '2026-01-01T00:00:00.000Z' }
          }
        })
      }),
      extract: { mutationResolver: resolver, sink }
    });

    await runDbMutationDirect<Todo, { title: string }>(
      {
        mutation: document<Record<string, Todo>, { input: unknown }>('CreateTodoExtract'),
        resultField: 'todoCreate',
        extract: { todo: true }
      },
      { title: 'Extract' }
    );

    expect(model.get('todo-extract')?.title).toBe('Extracted todo');
  });
});
