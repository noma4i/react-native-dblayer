import { act } from 'react';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind } from 'graphql';
import { belongsTo, configureDb, defineModel, defineShape, f, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime } from '../helpers/harness';

// Mirrors the app thread order and chat relation effects. Placement stays comparator-driven.

const CURRENT_USER_ID = 'me';

type MessageRow = { id: string; chatId: string; userId: string; body: string; createdAt: string; sequenceNumber: number | null };
type ChatRow = { id: string; unreadCount: number; lastActivityAt: number; lastMessageId: string | null; lastMessageAt: string | null; lastSequenceNumber: number | null };
type SendInput = { chatId: string; text: string; sequenceNumber: number; createdAt: string };
type SendData = { messageSend: { message: MessageRow } };
type SendVariables = { input: { chatId: string; text: string } };

const ChatSchema = defineShape<ChatRow>()({
  unreadCount: f.num(),
  lastActivityAt: f.num(),
  lastMessageId: f.str().nullable(),
  lastMessageAt: f.str().nullable(),
  lastSequenceNumber: f.num().nullable()
});
const MessageSchema = defineShape<MessageRow>()({
  chatId: f.str(),
  userId: f.str(),
  body: f.str(),
  createdAt: f.str(),
  sequenceNumber: f.num().nullable()
});
const document: TypedDocumentNode<SendData, SendVariables> = { kind: Kind.DOCUMENT, definitions: [] };

const compareNewestFirst = (left: MessageRow, right: MessageRow): number => {
  const leftSeq = left.sequenceNumber;
  const rightSeq = right.sequenceNumber;
  if (typeof leftSeq === 'number' && typeof rightSeq === 'number' && leftSeq !== rightSeq) return rightSeq - leftSeq;
  const leftCreated = Date.parse(left.createdAt);
  const rightCreated = Date.parse(right.createdAt);
  if (leftCreated !== rightCreated) return rightCreated - leftCreated;
  if (typeof leftSeq === 'number' && typeof rightSeq !== 'number') return -1;
  if (typeof leftSeq !== 'number' && typeof rightSeq === 'number') return 1;
  return right.id.localeCompare(left.id);
};

const isNewerThanChatPreview = (message: MessageRow, chat: ChatRow): boolean =>
  compareNewestFirst(message, {
    id: chat.lastMessageId ?? '',
    chatId: message.chatId,
    userId: '',
    body: '',
    createdAt: chat.lastMessageAt ?? '',
    sequenceNumber: chat.lastSequenceNumber
  }) < 0;

const createModels = (suffix: string, options?: { threadRetention?: number }) => {
  const chats = defineModel(`SpecConsumerChatsThread${suffix}`, { schema: ChatSchema });
  const messages = defineModel(`SpecConsumerMessagesThread${suffix}`, {
    schema: MessageSchema,
    associations: () => ({
      chat: belongsTo<MessageRow, ChatRow>(chats, {
        foreignKey: 'chatId',
        touch: (message, chat) =>
          isNewerThanChatPreview(message, chat)
            ? { lastActivityAt: Date.parse(message.createdAt), lastMessageId: message.id, lastMessageAt: message.createdAt, lastSequenceNumber: message.sequenceNumber }
            : null,
        counterCache: { field: 'unreadCount', filter: message => message.userId !== CURRENT_USER_ID }
      })
    }),
    relations: () => ({
      thread: {
        by: { chatId: 'chatId' },
        sort: { comparator: compareNewestFirst },
        retention: options?.threadRetention == null ? undefined : { maxRows: options.threadRetention }
      }
    }),
    maintenance: { dropTempRowsAfterMs: 1000 },
    actions: owner => ({
      send: owner.gql.action(document, {
        mode: 'request',
        result: 'messageSend',
        variables: (input: SendInput) => ({ input: { chatId: input.chatId, text: input.text } }),
        optimistic: {
          root: {
            insert: {
              select: ({ input, tempId }) => ({
                id: tempId,
                chatId: input.chatId,
                userId: CURRENT_USER_ID,
                body: input.text,
                createdAt: input.createdAt,
                sequenceNumber: input.sequenceNumber
              })
            }
          }
        },
        root: { insert: { select: ({ data }) => data.messageSend.message } }
      })
    })
  });
  return { chats, messages };
};

afterEach(resetRuntime);

describe('thread send consumer contracts', () => {
  it('issues above the local thread maximum when the chat preview is stale, before commit', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Insert');
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1, lastMessageId: 'm-old', lastMessageAt: new Date(1000).toISOString(), lastSequenceNumber: 3 });
    messages.insert({ id: 'm-old', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 5 });
    messages.insert({ id: 'm-new', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'newest', createdAt: new Date(2000).toISOString(), sequenceNumber: 10 });

    const reader = renderCounted(() => messages.thread({ chatId: 'chat-1' }).use().data);
    act(() => {
      messages.insert({
        id: 'temp-1',
        chatId: 'chat-1',
        userId: CURRENT_USER_ID,
        body: 'hi',
        createdAt: new Date().toISOString(),
        sequenceNumber: messages.thread({ chatId: 'chat-1' }).issueSequence('sequenceNumber')
      });
    });

    expect(reader.result().map(row => row.id)).toEqual(['temp-1', 'm-new', 'm-old']);
    reader.unmount();
  });

  it('swaps temp id for the server id in one counted render, preserving top position', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() =>
        ({
          data: { messageSend: { message: { id: 'server-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'hi', createdAt: new Date(2000).toISOString(), sequenceNumber: 6 } } }
        }) as { data: TData }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const { chats, messages } = createModels('Swap');
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1, lastMessageId: 'm-old', lastMessageAt: new Date(1000).toISOString(), lastSequenceNumber: 5 });
    messages.insert({ id: 'm-old', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 5 });

    const reader = renderCounted(() => messages.thread({ chatId: 'chat-1' }).use().data);
    const rendersBeforeSend = reader.renders();
    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = messages.actions.send.run({
        chatId: 'chat-1',
        text: 'hi',
        createdAt: new Date().toISOString(),
        sequenceNumber: messages.thread({ chatId: 'chat-1' }).issueSequence('sequenceNumber')
      });
    });
    const tempId = reader.result()[0]!.id;
    expect(tempId).not.toBe('server-1');
    const rendersAfterOptimistic = reader.renders();

    await act(async () => {
      await runPromise;
    });

    expect(reader.result().map(row => row.id)).toEqual(['server-1', 'm-old']);
    expect(rendersAfterOptimistic - rendersBeforeSend).toBe(1);
    expect(reader.renders() - rendersAfterOptimistic).toBe(1);
    reader.unmount();
  });

  it('issues strictly increasing values for a burst before any optimistic row applies', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Burst');
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1, lastMessageId: 'm-old', lastMessageAt: new Date(1000).toISOString(), lastSequenceNumber: 5 });
    messages.insert({ id: 'm-old', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 5 });

    const sameInstant = new Date(9999).toISOString();
    const issued = [
      messages.thread({ chatId: 'chat-1' }).issueSequence('sequenceNumber'),
      messages.thread({ chatId: 'chat-1' }).issueSequence('sequenceNumber'),
      messages.thread({ chatId: 'chat-1' }).issueSequence('sequenceNumber')
    ];
    expect(issued).toEqual([6, 7, 8]);
    act(() => {
      messages.insert({ id: 'temp-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'first', createdAt: sameInstant, sequenceNumber: issued[0] });
      messages.insert({ id: 'temp-2', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'second', createdAt: sameInstant, sequenceNumber: issued[1] });
      messages.insert({ id: 'temp-3', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'third', createdAt: sameInstant, sequenceNumber: issued[2] });
    });

    expect(messages.thread({ chatId: 'chat-1' }).read().map(row => row.id)).toEqual(['temp-3', 'temp-2', 'temp-1', 'm-old']);
  });

  it('clears issued values on resetRuntime and recomputes from the restored scope rows', () => {
    setupSpecRuntime();
    const { messages } = createModels('Reset');
    messages.insert({ id: 'm-10', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'latest', createdAt: new Date(10000).toISOString(), sequenceNumber: 10 });

    expect(messages.thread({ chatId: 'chat-1' }).issueSequence('sequenceNumber')).toBe(11);
    resetRuntime();
    messages.insert({ id: 'm-10', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'latest', createdAt: new Date(10000).toISOString(), sequenceNumber: 10 });

    expect(messages.thread({ chatId: 'chat-1' }).issueSequence('sequenceNumber')).toBe(11);
  });

  it('rejects a nullish scope value before issuing a sequence', () => {
    setupSpecRuntime();
    const { messages } = createModels('Nullish');

    expect(() => messages.thread(null).issueSequence('sequenceNumber')).toThrow('issueSequence requires an active relation');
  });

  it('keeps the issued maximum after scope retention trims rows below it', () => {
    setupSpecRuntime();
    const { messages } = createModels('Trim', { threadRetention: 1 });
    const scopeValue = { chatId: 'chat-1' };
    messages.insert({ id: 'm-10', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'latest', createdAt: new Date(10000).toISOString(), sequenceNumber: 10 });
    const first = messages.thread(scopeValue).issueSequence('sequenceNumber');
    messages.insert({ id: 'temp-11', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'optimistic', createdAt: new Date(11000).toISOString(), sequenceNumber: first });
    messages.thread(scopeValue).seed([{ id: 'm-10', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'latest', createdAt: new Date(10000).toISOString(), sequenceNumber: 10 }]);

    expect(messages.thread(scopeValue).read().map(row => row.id)).toEqual(['m-10']);
    expect(messages.thread(scopeValue).issueSequence('sequenceNumber')).toBe(12);
  });

  it('increments chat.unreadCount for an incoming other-user message, not for an own message', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Counter');
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0, lastMessageId: null, lastMessageAt: null, lastSequenceNumber: null });

    act(() => {
      messages.insert({ id: 'own-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'mine', createdAt: new Date(1000).toISOString(), sequenceNumber: 1 });
    });
    expect(chats.find('chat-1')?.unreadCount).toBe(0);

    act(() => {
      messages.insert({ id: 'other-1', chatId: 'chat-1', userId: 'them', body: 'theirs', createdAt: new Date(2000).toISOString(), sequenceNumber: 2 });
    });
    expect(chats.find('chat-1')?.unreadCount).toBe(1);
  });

  it('touches the chat preview row on a newer message and rerenders chat readers once, but not on an older/echo message', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Touch');
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1000, lastMessageId: 'm-mid', lastMessageAt: new Date(5000).toISOString(), lastSequenceNumber: 10 });
    // Sender is CURRENT_USER_ID throughout so counterCache (a separate side effect, gated on sender
    // identity, not recency) never fires here - isolates the touch-only render-count assertion below.
    messages.insert({ id: 'm-mid', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'mid', createdAt: new Date(5000).toISOString(), sequenceNumber: 10 });

    const reader = renderCounted(() => chats.useFind('chat-1'));
    const rendersBeforeOlder = reader.renders();
    act(() => {
      messages.insert({ id: 'm-older', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 3 });
    });
    expect(reader.renders() - rendersBeforeOlder).toBe(0);
    expect(reader.result()?.lastMessageId).toBe('m-mid');

    act(() => {
      messages.insert({ id: 'm-newer', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'newer', createdAt: new Date(9000).toISOString(), sequenceNumber: 11 });
    });
    expect(reader.renders() - rendersBeforeOlder).toBe(1);
    expect(reader.result()?.lastMessageId).toBe('m-newer');
    reader.unmount();
  });

});
