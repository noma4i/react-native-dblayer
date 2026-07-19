import { act } from 'react-test-renderer';
import { belongsTo, configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime } from '../helpers/harness';

// Mirrors yupi_v2 src/db/models/MessageModel.ts: thread scope by chatId, custom comparator
// (sequenceNumber desc -> createdAt desc -> id tiebreak, NULLS LAST only as a same-createdAt
// tiebreaker), belongsTo chat with touch + counterCache. See messageMutations.ts sendMessage
// for the real optimistic build (no prependTo/appendTo - pure comparator-driven placement).

const CURRENT_USER_ID = 'me';

type MessageRow = { id: string; chatId: string; userId: string; body: string; createdAt: string; sequenceNumber: number | null };
type ChatRow = { id: string; unreadCount: number; lastActivityAt: number; lastMessageId: string | null; lastMessageAt: string | null; lastSequenceNumber: number | null };

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

const createModels = (suffix: string) => {
  const issuedSequenceByChat = new Map<string, number>();
  const chats = defineModel({
    id: `SpecConsumerChatsThread${suffix}`,
    name: `SpecConsumerChatsThread${suffix}`,
    fields: {
      id: f.str(),
      unreadCount: f.num(),
      lastActivityAt: f.num(),
      lastMessageId: f.str().nullable(),
      lastMessageAt: f.str().nullable(),
      lastSequenceNumber: f.num().nullable()
    }
  });
  const messages = defineModel({
    id: `SpecConsumerMessagesThread${suffix}`,
    name: `SpecConsumerMessagesThread${suffix}`,
    fields: {
      id: f.str(),
      chatId: f.str(),
      userId: f.str(),
      body: f.str(),
      createdAt: f.str(),
      sequenceNumber: f.num().nullable()
    },
    relations: () => ({
      chat: belongsTo<MessageRow, ChatRow>(chats, {
        foreignKey: 'chatId',
        touch: (message, chat) =>
          isNewerThanChatPreview(message, chat)
            ? { lastActivityAt: Date.parse(message.createdAt), lastMessageId: message.id, lastMessageAt: message.createdAt, lastSequenceNumber: message.sequenceNumber }
            : null,
        counterCache: { field: 'unreadCount', filter: message => message.userId !== CURRENT_USER_ID }
      })
    }),
    scopes: {
      thread: scope<MessageRow>({ by: { chatId: 'chatId' }, sort: { comparator: compareNewestFirst } })
    }
  });
  const nextOptimisticSequence = (chatId: string): number => {
    const lastKnown = chats.get(chatId)?.lastSequenceNumber ?? 0;
    const issued = issuedSequenceByChat.get(chatId) ?? 0;
    const next = Math.max(lastKnown, issued) + 1;
    issuedSequenceByChat.set(chatId, next);
    return next;
  };
  return { chats, messages, nextOptimisticSequence };
};

const document = { kind: 'Document', definitions: [] } as never;

describe('thread send consumer contracts', () => {
  it('optimistic send inserts the temp row at the top of the thread scope, newest-first', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Insert');
    chats.insertStored({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1, lastMessageId: 'm-old', lastMessageAt: new Date(1000).toISOString(), lastSequenceNumber: 5 });
    messages.insertStored({ id: 'm-old', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 5 });

    const reader = renderCounted(() => messages.scopes.thread.use({ chatId: 'chat-1' }));
    act(() => {
      messages.insertStored({ id: 'temp-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'hi', createdAt: new Date().toISOString(), sequenceNumber: 6 });
    });

    expect(reader.result().map(row => row.id)).toEqual(['temp-1', 'm-old']);
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
    const { chats, messages, nextOptimisticSequence } = createModels('Swap');
    chats.insertStored({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1, lastMessageId: 'm-old', lastMessageAt: new Date(1000).toISOString(), lastSequenceNumber: 5 });
    messages.insertStored({ id: 'm-old', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 5 });

    const sendMessage = messages.mutation<{ messageSend: { message: MessageRow } }, { chatId: string; text: string }, MessageRow, MessageRow>('send', {
      document,
      result: 'messageSend',
      optimistic: {
        model: messages,
        tempIdPrefix: 'msg',
        build: (input, { tempId }) => ({
          id: tempId!,
          chatId: input.chatId,
          userId: CURRENT_USER_ID,
          body: input.text,
          createdAt: new Date().toISOString(),
          sequenceNumber: nextOptimisticSequence(input.chatId)
        }),
        selectServerNode: data => data.messageSend.message
      }
    });

    const reader = renderCounted(() => messages.scopes.thread.use({ chatId: 'chat-1' }));
    const rendersBeforeSend = reader.renders();
    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = sendMessage.run({ chatId: 'chat-1', text: 'hi' });
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

  it('keeps two optimistic sends in send order among server rows (sequence floors)', () => {
    setupSpecRuntime();
    const { chats, messages, nextOptimisticSequence } = createModels('Burst');
    chats.insertStored({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1, lastMessageId: 'm-old', lastMessageAt: new Date(1000).toISOString(), lastSequenceNumber: 5 });
    messages.insertStored({ id: 'm-old', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 5 });

    const sameInstant = new Date(9999).toISOString();
    act(() => {
      messages.insertStored({ id: 'temp-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'first', createdAt: sameInstant, sequenceNumber: nextOptimisticSequence('chat-1') });
      messages.insertStored({ id: 'temp-2', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'second', createdAt: sameInstant, sequenceNumber: nextOptimisticSequence('chat-1') });
    });

    expect(messages.scopes.thread.read({ chatId: 'chat-1' }).map(row => row.id)).toEqual(['temp-2', 'temp-1', 'm-old']);
  });

  it('increments chat.unreadCount for an incoming other-user message, not for an own message', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Counter');
    chats.insertStored({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0, lastMessageId: null, lastMessageAt: null, lastSequenceNumber: null });

    act(() => {
      messages.insertStored({ id: 'own-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'mine', createdAt: new Date(1000).toISOString(), sequenceNumber: 1 });
    });
    expect(chats.get('chat-1')?.unreadCount).toBe(0);

    act(() => {
      messages.insertStored({ id: 'other-1', chatId: 'chat-1', userId: 'them', body: 'theirs', createdAt: new Date(2000).toISOString(), sequenceNumber: 2 });
    });
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
  });

  it('touches the chat preview row on a newer message and rerenders chat readers once, but not on an older/echo message', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Touch');
    chats.insertStored({ id: 'chat-1', unreadCount: 0, lastActivityAt: 1000, lastMessageId: 'm-mid', lastMessageAt: new Date(5000).toISOString(), lastSequenceNumber: 10 });
    // Sender is CURRENT_USER_ID throughout so counterCache (a separate side effect, gated on sender
    // identity, not recency) never fires here - isolates the touch-only render-count assertion below.
    messages.insertStored({ id: 'm-mid', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'mid', createdAt: new Date(5000).toISOString(), sequenceNumber: 10 });

    const reader = renderCounted(() => chats.use.row('chat-1'));
    const rendersBeforeOlder = reader.renders();
    act(() => {
      messages.insertStored({ id: 'm-older', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'older', createdAt: new Date(1000).toISOString(), sequenceNumber: 3 });
    });
    expect(reader.renders() - rendersBeforeOlder).toBe(0);
    expect(reader.result()?.lastMessageId).toBe('m-mid');

    act(() => {
      messages.insertStored({ id: 'm-newer', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'newer', createdAt: new Date(9000).toISOString(), sequenceNumber: 11 });
    });
    expect(reader.renders() - rendersBeforeOlder).toBe(1);
    expect(reader.result()?.lastMessageId).toBe('m-newer');
    reader.unmount();
  });

  it('reconciles a server event for the same logical message without a duplicate or extra membership entry', () => {
    setupSpecRuntime();
    const { chats, messages } = createModels('Reconcile');
    chats.insertStored({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0, lastMessageId: null, lastMessageAt: null, lastSequenceNumber: null });
    messages.insertStored({ id: 'temp-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'hi', createdAt: new Date(1000).toISOString(), sequenceNumber: 1 });

    act(() => {
      messages.replaceRaw('temp-1', { id: 'server-1', chatId: 'chat-1', userId: CURRENT_USER_ID, body: 'hi', createdAt: new Date(1000).toISOString(), sequenceNumber: 1 });
    });

    const rows = messages.scopes.thread.read({ chatId: 'chat-1' });
    expect(rows.map(row => row.id)).toEqual(['server-1']);
    expect(messages.get('temp-1')).toBeUndefined();
  });
});
