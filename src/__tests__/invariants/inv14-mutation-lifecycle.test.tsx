import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { parse } from 'graphql';
import { belongsTo } from '../../core/relations';
import { resetRuntime } from '../../core/reset';
import { getApplyRuntime, getOperationState, configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { defineMutation } from '../../dsl/defineMutation';
import { f } from '../../schema/f';
import { isTempId } from '../../utils/generateTempId';
import type { StoragePlane } from '../../core/planes/storagePlane';

type Message = { id: string; chatId: string; text: string; kind: string; localEcho?: string };
type MutationData = { messageSend: { message: Message } | null; chat?: { id: string; unreadCount: number; lastText: string } };
type Input = { id?: string; text: string; chatId?: string; kind?: string };
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };

const document = parse('mutation SendMessage { messageSend { message { id chatId text kind localEcho } } }');

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const renderMutation = <TInput, TData>(mutation: {
  use: () => {
    mutate(input: TInput, callbacks?: { onSuccess?: (data: TData | null) => void; onError?: (error: Error) => void; onSettled?: () => void }): void;
    mutateAsync(input: TInput): Promise<TData | null>;
    isPending: boolean;
    error: Error | null;
  };
}) => {
  let value: ReturnType<typeof mutation.use>;
  const Reader = () => {
    value = mutation.use();
    return null;
  };
  let root: TestRenderer.ReactTestRenderer;
  act(() => { root = TestRenderer.create(<Reader />); });
  return { value: () => value!, unmount: () => act(() => root!.unmount()) };
};

const setup = (mutation: () => Promise<{ data: MutationData }>) => {
  const storage = createStorage();
  let calls = 0;
  configureDb({
    storage,
    transport: {
      query: async () => ({ data: {} }),
      mutation: async () => {
        calls += 1;
        return mutation();
      }
    } as any
  });
  let chats: any;
  let messages: any;
  chats = defineModel({
    id: 'chats',
    name: 'chats',
    fields: { unreadCount: f.num(), lastText: f.str() }
  });
  messages = defineModel({
    id: 'messages',
    name: 'messages',
    fields: { chatId: f.str(), text: f.str(), kind: f.str(), localEcho: f.str() },
    relations: () => ({
      chat: belongsTo(chats, {
        foreignKey: 'chatId',
        touch: (message: any) => ({ lastText: message.text }),
        counterCache: { field: 'unreadCount' as any, filter: (message: any) => message.kind !== 'system' }
      })
    })
  });
  const chat = (overrides: Record<string, unknown> = {}) => ({ id: 'chat-1', unreadCount: 0, lastText: '', ...overrides });
  const message = (id: string, overrides: Record<string, unknown> = {}) => ({ id, chatId: 'chat-1', text: 'before', kind: 'user', ...overrides });
  return { storage, chats, messages, calls: () => calls, chat, message };
};

const send = (messages: any, options: Record<string, unknown> = {}) =>
  defineMutation<MutationData, Input, Message, Message>({
    document,
    result: 'messageSend',
    optimistic: {
      model: messages,
      build: (input: Input) => ({
        id: 'ignored',
        chatId: input.chatId ?? 'chat-1',
        text: input.text,
        kind: input.kind ?? 'user',
        localEcho: input.text === 'preserve' ? 'x' : undefined
      }),
      selectServerNode: (data: MutationData) => data.messageSend?.message
    },
    ...options
  } as any);

const server = (id = 'server-1', overrides: Partial<Message> = {}): { data: MutationData } => ({
  data: { messageSend: { message: { id, chatId: 'chat-1', text: 'server', kind: 'user', ...overrides } } }
});

describe('v6 invariant 14: mutation lifecycle', () => {
  it('inserts an optimistic row and replaces it with the server row', async () => {
    const hold = deferred<{ data: MutationData }>();
    const { messages } = setup(() => hold.promise);
    const mutation = send(messages);
    const view = renderMutation(mutation);
    let pending!: Promise<MutationData | null>;
    act(() => { pending = view.value().mutateAsync({ text: 'optimistic' }); });
    const temporary = messages.getWhere({}).find((row: Message) => isTempId(row.id));
    expect(temporary).toBeDefined();
    expect(messages.get(temporary.id)).toEqual(temporary);
    expect(isTempId(temporary.id)).toBe(true);
    hold.resolve(server());
    await act(async () => { await pending; });
    expect(messages.get(temporary.id)).toBeUndefined();
    expect(messages.get('server-1')?.text).toBe('server');
    view.unmount();
  });

  it('preserves local fields and commits replace, preserve, and extract in one epoch', async () => {
    const hold = deferred<{ data: MutationData }>();
    const { chats, messages, chat } = setup(() => hold.promise);
    chats.insertStored(chat());
    const mutation = send(messages, {
      optimistic: {
        model: messages,
        build: (input: Input) => ({ id: 'ignored', chatId: input.chatId ?? 'chat-1', text: input.text, kind: 'user', localEcho: 'x' }),
        selectServerNode: (data: MutationData) => data.messageSend?.message,
        preserveOnCommit: ['localEcho']
      },
      extract: () => [{ into: chats, rows: [{ id: 'chat-1', unreadCount: 1, lastText: 'from-extract' }] }]
    });
    const pending = mutation.run({ text: 'preserve' });
    const beforeCommit = getApplyRuntime().currentEpoch();
    hold.resolve(server('server-preserve', { text: 'server text' }));
    await pending;
    expect(getApplyRuntime().currentEpoch()).toBe(beforeCommit + 1);
    expect(messages.get('server-preserve')).toMatchObject({ localEcho: 'x', text: 'server text' });
    expect(chats.get('chat-1')?.lastText).toBe('from-extract');
  });

  it('rolls back an optimistic insert and exposes the hook error with its temp id', async () => {
    const { messages } = setup(async () => { throw new Error('insert failed'); });
    const errors: Array<{ message: string; tempId: string | null }> = [];
    const mutation = send(messages, {
      onError: (error: Error, ctx: { tempId: string | null }) => errors.push({ message: error.message, tempId: ctx.tempId })
    });
    const view = renderMutation(mutation);
    await act(async () => { await expect(view.value().mutateAsync({ text: 'rollback' })).rejects.toThrow('insert failed'); });
    expect(messages.getWhere({})).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(isTempId(errors[0].tempId)).toBe(true);
    expect(view.value().error?.message).toBe('insert failed');
    view.unmount();
  });

  it('rolls back an optimistic patch', async () => {
    const { messages, message } = setup(async () => { throw new Error('patch failed'); });
    messages.insertStored(message('message-1'));
    const mutation = defineMutation<any, Input, Message, Message>({
      document,
      result: 'messageSend',
      optimistic: { method: 'patch', model: messages, selectId: input => input.id!, selectPatch: input => ({ text: input.text }) }
    });
    const pending = mutation.run({ id: 'message-1', text: 'after' });
    expect(messages.get('message-1')?.text).toBe('after');
    await expect(pending).rejects.toThrow('patch failed');
    expect(messages.get('message-1')?.text).toBe('before');
  });

  it('rolls back an optimistic destroy', async () => {
    const { messages, message } = setup(async () => { throw new Error('destroy failed'); });
    messages.insertStored(message('message-1'));
    const mutation = defineMutation<any, Input, Message, Message>({
      document,
      result: 'messageSend',
      optimistic: { method: 'destroy', model: messages, selectId: input => input.id! }
    });
    const pending = mutation.run({ id: 'message-1', text: 'unused' });
    expect(messages.get('message-1')).toBeUndefined();
    await expect(pending).rejects.toThrow('destroy failed');
    expect(messages.get('message-1')?.text).toBe('before');
  });

  it('deduplicates a committed idempotency key', async () => {
    const { messages, calls } = setup(async () => server('dedupe-1'));
    const mutation = send(messages, { dedupe: { key: (input: Input) => input.text } });
    await expect(mutation.run({ text: 'same' })).resolves.toEqual(server('dedupe-1').data);
    await expect(mutation.run({ text: 'same' })).resolves.toBeNull();
    expect(calls()).toBe(1);
  });

  it('deduplicates a pending idempotency key', async () => {
    const hold = deferred<{ data: MutationData }>();
    const { messages, calls } = setup(() => hold.promise);
    const mutation = send(messages, { dedupe: { key: (input: Input) => input.text } });
    const first = mutation.run({ text: 'double-tap' });
    await expect(mutation.run({ text: 'double-tap' })).resolves.toBeNull();
    expect(calls()).toBe(1);
    hold.resolve(server('dedupe-pending'));
    await first;
  });

  it('commits extracted chat data in the same transaction as the replacement', async () => {
    const hold = deferred<{ data: MutationData }>();
    const { chats, messages, chat } = setup(() => hold.promise);
    chats.insertStored(chat());
    const mutation = send(messages, {
      extract: () => [{ into: chats, rows: [{ id: 'chat-1', unreadCount: 1, lastText: 'extracted' }] }]
    });
    const pending = mutation.run({ text: 'extract' });
    const beforeCommit = getApplyRuntime().currentEpoch();
    hold.resolve(server('extract-1'));
    await pending;
    expect(getApplyRuntime().currentEpoch()).toBe(beforeCommit + 1);
    expect(chats.get('chat-1')?.lastText).toBe('extracted');
  });

  it('runs lifecycle callbacks in order with the same optimistic context', async () => {
    const hold = deferred<{ data: MutationData }>();
    const { messages } = setup(async () => {
      events.push('transport');
      return hold.promise;
    });
    const events: string[] = [];
    let tempId: string | null = null;
    let operationId: string | null = null;
    const input = { text: 'lifecycle' };
    const mutation = send(messages, {
      onMutate: (_input: Input, ctx: { tempId: string | null; operationId: string }) => {
        tempId = ctx.tempId;
        operationId = ctx.operationId;
        events.push('mutate');
      },
      onCommit: (data: MutationData, ctx: { tempId: string | null; operationId: string; input: Input }) => {
        expect(ctx).toEqual({ tempId, operationId, input });
        expect(data.messageSend?.message.id).toBe('lifecycle-1');
        events.push('commit');
      },
      invalidate: (ctx: { input: Input; data: MutationData }) => {
        expect(ctx.input).toEqual(input);
        expect(ctx.data.messageSend?.message.id).toBe('lifecycle-1');
        events.push('invalidate');
      },
      track: (ctx: { input: Input; data: MutationData }) => {
        expect(ctx.input).toEqual(input);
        expect(ctx.data.messageSend?.message.id).toBe('lifecycle-1');
        events.push('track');
      }
    });
    const pending = mutation.run(input);
    expect(isTempId(tempId)).toBe(true);
    expect(events).toEqual(['mutate', 'transport']);
    hold.resolve(server('lifecycle-1'));
    await pending;
    expect(events).toEqual(['mutate', 'transport', 'commit', 'invalidate', 'track']);
  });

  it('rolls back when the result payload is null', async () => {
    const { storage, messages } = setup(async () => ({ data: { messageSend: null } }));
    const mutation = send(messages, { dedupe: { key: (input: Input) => input.text } });
    await expect(mutation.run({ text: 'null-payload' })).rejects.toThrow('messageSend returned no data');
    expect(messages.getWhere({})).toEqual([]);
    const entries = getOperationState().persistEntries();
    const raw = entries.find(entry => entry.key.endsWith('ops'))?.value;
    const operations = Object.values(JSON.parse(raw!) as Record<string, { status: string }>);
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe('rolledback');
    expect(storage.get('dbl:ops')).toBe(raw);
  });

  it('keeps the counter consistent through insert rollback and replacement', async () => {
    const first = deferred<{ data: MutationData }>();
    const outcomes: Array<Promise<{ data: MutationData }>> = [first.promise, Promise.resolve(server('counter-server'))];
    const { chats, messages, chat } = setup(() => outcomes.shift()!);
    chats.insertStored(chat());
    const mutation = send(messages);
    const failed = mutation.run({ text: 'counter' });
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
    first.reject(new Error('counter failed'));
    await expect(failed).rejects.toThrow('counter failed');
    expect(chats.get('chat-1')?.unreadCount).toBe(0);
    await mutation.run({ text: 'counter' });
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
  });

  it('calls hook mutation callbacks without an unhandled rejection', async () => {
    const { messages } = setup(async () => server('callback-success'));
    const mutation = send(messages);
    const view = renderMutation(mutation);
    const success = jest.fn();
    const error = jest.fn();
    const settled = jest.fn();

    await new Promise<void>(resolve => {
      act(() => {
        view.value().mutate(
          { text: 'callback-success' },
          {
            onSuccess: data => {
              success(data);
            },
            onError: error,
            onSettled: () => {
              settled();
              resolve();
            }
          }
        );
      });
    });
    expect(success).toHaveBeenCalledWith(server('callback-success').data);
    expect(error).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    view.unmount();

    const failed = setup(async () => { throw new Error('callback failed'); });
    const failedMutation = send(failed.messages);
    const failedView = renderMutation(failedMutation);
    const failedSuccess = jest.fn();
    const failedError = jest.fn();
    const failedSettled = jest.fn();
    await new Promise<void>(resolve => {
      act(() => {
        failedView.value().mutate(
          { text: 'callback-failure' },
          {
            onSuccess: failedSuccess,
            onError: nextError => {
              failedError(nextError);
            },
            onSettled: () => {
              failedSettled();
              resolve();
            }
          }
        );
      });
    });
    expect(failedSuccess).not.toHaveBeenCalled();
    expect(failedError).toHaveBeenCalledWith(expect.objectContaining({ message: 'callback failed' }));
    expect(failedSettled).toHaveBeenCalledTimes(1);
    failedView.unmount();
  });

  it('resets models synchronously and permits a fresh insert', () => {
    const { messages, message } = setup(async () => server());
    messages.insertStored(message('before-reset'));
    resetRuntime();
    expect(messages.get('before-reset')).toBeUndefined();
    messages.insertStored(message('after-reset'));
    expect(messages.get('after-reset')).toMatchObject({ id: 'after-reset', text: 'before' });
  });
});
