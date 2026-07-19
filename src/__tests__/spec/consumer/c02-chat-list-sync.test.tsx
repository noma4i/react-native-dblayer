import { act } from 'react-test-renderer';
import { configureDb, createDbSubscriptionRuntime, createThrottledSingleFlight, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime } from '../helpers/harness';

// Mirrors yupi_v2 src/db/models/ChatModel.ts: throttled single-flight sync mutation, and
// src/db/subscriptions/entries.ts-style chatIngest with a chatUpdated debounce per-chat.

type ChatRow = { id: string; status: string; title: string; lastActivityAt: number };

const document = { kind: 'Document', definitions: [] } as never;

const createChats = (suffix: string) =>
  defineModel({
    id: `SpecConsumerChatsSync${suffix}`,
    name: `SpecConsumerChatsSync${suffix}`,
    fields: { id: f.str(), status: f.str(), title: f.str(), lastActivityAt: f.num() },
    scopes: {
      list: scope<ChatRow>({ by: { status: 'status' }, sort: { field: 'lastActivityAt', dir: 'desc' } })
    }
  });

describe('chat list sync consumer contracts', () => {
  it('coalesces N concurrent sync() calls within the throttle window into exactly one transport call, all callers resolving', async () => {
    let mutationCalls = 0;
    const transport = createMockTransport({
      mutation: async <TData,>() => {
        mutationCalls += 1;
        return { data: { chatSync: { chats: [] } } } as { data: TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const chats = createChats('Throttle');
    const syncMutation = chats.mutation<{ chatSync: { chats: ChatRow[] } }, { chatId: string }, ChatRow, never>('sync', {
      document,
      result: 'chatSync',
      dedupe: false
    });
    const sync = createThrottledSingleFlight((input: { chatId: string }) => syncMutation.run(input), { minIntervalMs: 8000 });

    const calls = [sync({ chatId: 'chat-1' }), sync({ chatId: 'chat-1' }), sync({ chatId: 'chat-1' })];
    await expect(Promise.all(calls)).resolves.toEqual(expect.any(Array));
    expect(mutationCalls).toBe(1);
  });

  it('debounces chatUpdated per-chat: M rapid events collapse into one apply wave, other chats are not cross-collapsed', () => {
    jest.useFakeTimers();
    setupSpecRuntime();
    const chats = createChats('Debounce');
    chats.insertStored({ id: 'chat-a', status: 'primary', title: 'A before', lastActivityAt: 1 });
    chats.insertStored({ id: 'chat-b', status: 'primary', title: 'B before', lastActivityAt: 2 });

    const ingest = chats.ingest({
      chatUpdated: {
        handler: payload => ({ upsert: (payload as { chat: ChatRow }).chat }),
        debounce: { ms: 50, keyOf: payload => (payload as { chat: ChatRow }).chat.id }
      }
    });
    const runtime = createDbSubscriptionRuntime(ingest.entries);

    const reader = renderCounted(() => chats.scopes.list.use({ status: 'primary' }));
    const rendersBeforeChatA = reader.renders();

    act(() => {
      runtime.dispatch('chatUpdated', { chat: { id: 'chat-a', status: 'primary', title: 'A v1', lastActivityAt: 10 } });
      runtime.dispatch('chatUpdated', { chat: { id: 'chat-a', status: 'primary', title: 'A v2', lastActivityAt: 11 } });
      runtime.dispatch('chatUpdated', { chat: { id: 'chat-a', status: 'primary', title: 'A v3', lastActivityAt: 12 } });
      jest.advanceTimersByTime(50);
    });

    // 3 rapid events for chat-a collapse into exactly one apply wave (one debounce bucket, latest wins).
    expect(reader.renders() - rendersBeforeChatA).toBe(1);
    expect(chats.get('chat-a')?.title).toBe('A v3');

    const rendersBeforeChatB = reader.renders();
    act(() => {
      runtime.dispatch('chatUpdated', { chat: { id: 'chat-b', status: 'primary', title: 'B v1', lastActivityAt: 20 } });
      jest.advanceTimersByTime(50);
    });

    // chat-b is a separate debounce bucket - its own apply wave, not swallowed by chat-a's already-fired bucket.
    expect(reader.renders() - rendersBeforeChatB).toBe(1);
    expect(chats.get('chat-b')?.title).toBe('B v1');
    reader.unmount();
    runtime.stop();
    jest.useRealTimers();
  });

  it('destroys a chat and its scope membership in one commit: reader sees one render, no ghost row', () => {
    setupSpecRuntime();
    const chats = createChats('Delete');
    chats.insertStored({ id: 'chat-a', status: 'primary', title: 'A', lastActivityAt: 1 });
    chats.insertStored({ id: 'chat-b', status: 'primary', title: 'B', lastActivityAt: 2 });

    const ingest = chats.ingest({
      chatDeleted: { handler: payload => ({ destroy: (payload as { chatId: string }).chatId }) }
    });

    const reader = renderCounted(() => chats.scopes.list.use({ status: 'primary' }));
    const rendersBefore = reader.renders();

    act(() => {
      ingest.apply('chatDeleted', { chatId: 'chat-a' });
    });

    expect(reader.renders() - rendersBefore).toBe(1);
    expect(reader.result().map(row => row.id)).toEqual(['chat-b']);
    expect(chats.get('chat-a')).toBeUndefined();
    reader.unmount();
  });
});
