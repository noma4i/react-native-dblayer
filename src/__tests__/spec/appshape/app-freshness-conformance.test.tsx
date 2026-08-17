import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { focusManager } from '@tanstack/react-query';
import { act } from 'react';
import { bootDb, compositeKey, configureDb, defineModel, defineShape, f, setFetchNetworkOnline, type QueryPersistenceRecord } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCountedInProvider, settle, settleUntil } from '../helpers/harness';

/**
 * Freshness and pagination as yupi declares them, not as a synthetic case would.
 *
 * The three declarations below are copied from the app: `ChatModel.list` (paged, page coverage,
 * capped, push-backed), `ChatModel.details` (single, empty results retried sooner) and
 * `MessageModel.thread` (paged backward, uncapped - the server's `pageInfo` is the only history
 * boundary). Their freshness classes carry the app's names and values.
 *
 * What these cases pin is WHO may cause a request and WHEN, which is the part a change of
 * scheduling ownership can silently break: a cold start on fresh data must stay silent, an expired
 * window must cost exactly one request, and a background refresh must never shorten a chain the
 * user has already paged through.
 */
const FRESHNESS = { PUSH_BACKED: 300_000, EMPTY_RETRY: 30_000, CATALOG: 7_200_000 };
const MAX_PAGES_CHATS = 20;

type ChatInput = { id: string; status: string; lastActivityAt: string };
type MessageInput = { id: string; chatId: string; body: string };
type ChatListData = { chats: { nodes: ChatInput[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type ChatListVariables = { statusFilter: string; after?: string | null };
type ChatDetailData = { chat: ChatInput | null };
type ThreadData = { chat: { messages: { nodes: MessageInput[]; pageInfo: { hasPreviousPage: boolean; startCursor: string | null } } } };
type ThreadVariables = { chatId: string; before?: string | null };
type CatalogInput = { value: string };
type CatalogData = { catalog: CatalogInput };

const chatsDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ChatListData, ChatListVariables>;
const chatDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ChatDetailData, { id: string }>;
const threadDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ThreadData, ThreadVariables>;
const catalogDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<CatalogData, Record<string, never>>;

const ChatSchema = defineShape<ChatInput>()({ status: f.str(), lastActivityAt: f.str() });
const MessageSchema = defineShape<MessageInput>()({ chatId: f.id(), body: f.str() });

const configure = (storage: ReturnType<typeof createMemoryPlane>, transport: ReturnType<typeof createMockTransport>): void => {
  configureDb({ storage, transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: FRESHNESS } });
};

/** `ChatModel.list`: connection, page coverage, capped, push-backed. */
const defineChats = (tag: string) =>
  defineModel(`AppFreshnessChat${tag}`, {
    schema: ChatSchema,
    relations: owner => ({
      list: {
        by: { statusFilter: 'status' },
        sort: { field: 'lastActivityAt', dir: 'desc' },
        remote: owner.gql.connection(chatsDocument, {
          variables: (params: { statusFilter: string }) => ({ statusFilter: params.statusFilter }),
          connection: data => data.chats,
          maxPages: MAX_PAGES_CHATS,
          staleTime: 'PUSH_BACKED',
          coverage: 'page'
        })
      },
      details: {
        remote: owner.gql.single(chatDocument, {
          variables: (params: { chatId: string }) => ({ id: params.chatId }),
          select: data => data.chat,
          staleTime: 'PUSH_BACKED',
          emptyStaleTime: 'EMPTY_RETRY'
        })
      }
    })
  });

/** `MessageModel.thread`: connection read backward, uncapped. */
const defineMessages = (tag: string) =>
  defineModel(`AppFreshnessMessage${tag}`, {
    schema: MessageSchema,
    relations: owner => ({
      thread: {
        by: { chatId: 'chatId' },
        sort: 'server-order',
        remote: owner.gql.connection(threadDocument, {
          variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
          connection: data => data.chat.messages,
          direction: 'backward',
          staleTime: 'PUSH_BACKED',
          coverage: 'page'
        })
      }
    })
  });

const chatPage = (index: number, hasNextPage: boolean): ChatListData => ({
  chats: {
    nodes: [{ id: `chat-${index}`, status: 'active', lastActivityAt: `2026-08-0${index}T00:00:00Z` }],
    pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${index}` : null }
  }
});

const threadPage = (index: number, hasPreviousPage: boolean): ThreadData => ({
  chat: {
    messages: {
      nodes: [{ id: `m-${index}`, chatId: 'chat-1', body: `body-${index}` }],
      pageInfo: { hasPreviousPage, startCursor: hasPreviousPage ? `cursor-${index}` : null }
    }
  }
});

const createCatalogTransport = (onCall: () => void) =>
  createMockTransport({
    query: async <TData,>() => {
      onCall();
      return { data: { catalog: { value: 'catalog' } } as TData };
    }
  });

const defineCatalogModel = (tag: string) =>
  defineModel(`AppFreshnessCatalog${tag}`, {
    schema: defineShape<CatalogInput>()({ value: f.str() }),
    rowId: () => 'catalog',
    relations: owner => ({
      catalog: {
        remote: owner.gql.single(catalogDocument, {
          variables: () => ({}),
          select: data => data.catalog,
          staleTime: 'CATALOG'
        })
      }
    })
  });

const readOnlyQueryRecord = (storage: ReturnType<typeof createMemoryPlane>): QueryPersistenceRecord<{ ids: string[] }> => {
  const key = storage.snapshotKeys().find(candidate => candidate.startsWith('dbl:query:'));
  if (key === undefined) throw new Error('query record is missing');
  const envelope = JSON.parse(storage.get(key)!) as { payload: QueryPersistenceRecord<{ ids: string[] }> };
  return envelope.payload;
};

describe('app-shaped freshness conformance', () => {
  afterEach(() => {
    setFetchNetworkOnline(true);
    jest.useRealTimers();
  });

  it('B1 keeps a catalog fetch silent on cold start while its window still holds', async () => {
    jest.useFakeTimers();
    const storage = createMemoryPlane();
    let calls = 0;
    configure(storage, createCatalogTransport(() => { calls += 1; }));
    const first = defineCatalogModel('ColdFresh');
    await bootDb();
    await first.catalog({}).fetch();
    expect(calls).toBe(1);
    jest.advanceTimersByTime(FRESHNESS.CATALOG - 1);

    configure(storage, createCatalogTransport(() => { calls += 1; }));
    const restarted = defineCatalogModel('ColdFresh');
    await bootDb();
    const reader = renderCountedInProvider(() => restarted.catalog({}).use());
    await settle();

    expect(reader.result().data).toEqual({ id: 'catalog', value: 'catalog' });
    expect(calls).toBe(1);
    reader.unmount();
  });

  it('B2 refetches a catalog fetch exactly once when its window has closed', async () => {
    jest.useFakeTimers();
    const storage = createMemoryPlane();
    let calls = 0;
    configure(storage, createCatalogTransport(() => { calls += 1; }));
    const first = defineCatalogModel('ColdExpired');
    await bootDb();
    await first.catalog({}).fetch();
    jest.advanceTimersByTime(FRESHNESS.CATALOG + 1);

    configure(storage, createCatalogTransport(() => { calls += 1; }));
    const restarted = defineCatalogModel('ColdExpired');
    await bootDb();
    const reader = renderCountedInProvider(() => restarted.catalog({}).use());
    await settleUntil(() => calls === 2);
    // Settle past the refetch: a second refetch of the same expired window would show up here.
    await settle();

    expect(calls).toBe(2);
    expect(reader.result().data).toEqual({ id: 'catalog', value: 'catalog' });
    // The refetch reopened the window: a second reader mounting inside it serves the same data
    // without asking the server again.
    const second = renderCountedInProvider(() => restarted.catalog({}).use());
    await settle();
    expect(calls).toBe(2);
    expect(second.result().data).toEqual({ id: 'catalog', value: 'catalog' });
    second.unmount();
    reader.unmount();
  });

  it('B3 pauses a catalog fetch mounted offline and catches up on reconnect', async () => {
    let calls = 0;
    const storage = createMemoryPlane();
    configure(storage, createCatalogTransport(() => { calls += 1; }));
    const catalog = defineCatalogModel('Offline');
    await bootDb();
    setFetchNetworkOnline(false);
    const reader = renderCountedInProvider(() => catalog.catalog({}).use());
    await settle();
    await settle(1, { macro: true });
    expect(calls).toBe(0);
    expect(reader.result().loadingState.isOffline).toBe(true);

    await act(async () => {
      setFetchNetworkOnline(true);
    });
    await settleUntil(() => calls === 1, 50, { macro: true });

    expect(calls).toBe(1);
    reader.unmount();
  });

  it('A1 keeps a push-backed chat list silent on cold start while its window still holds', async () => {
    jest.useFakeTimers();
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: chatPage(1, false) as TData };
      }
    });
    configure(storage, transport);
    const Chat = defineChats('ColdFresh');
    await bootDb();
    await Chat.list({ statusFilter: 'active' }).fetch();
    expect(calls).toBe(1);
    jest.advanceTimersByTime(FRESHNESS.PUSH_BACKED - 1);

    configure(storage, transport);
    const Restarted = defineChats('ColdFresh');
    await bootDb();
    const reader = renderCountedInProvider(() => Restarted.list({ statusFilter: 'active' }).use());
    await settle();

    expect(reader.result().data.map(row => row.id)).toEqual(['chat-1']);
    expect(calls).toBe(1);
    reader.unmount();
  });

  it('A2 refetches the chat list exactly once when its window has closed', async () => {
    jest.useFakeTimers();
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: chatPage(1, false) as TData };
      }
    });
    configure(storage, transport);
    const Chat = defineChats('ColdExpired');
    await bootDb();
    await Chat.list({ statusFilter: 'active' }).fetch();
    jest.advanceTimersByTime(FRESHNESS.PUSH_BACKED + 1);

    configure(storage, transport);
    const Restarted = defineChats('ColdExpired');
    await bootDb();
    const reader = renderCountedInProvider(() => Restarted.list({ statusFilter: 'active' }).use());
    await settleUntil(() => calls === 2);
    // Settle past the refetch: a second refetch of the same expired window would show up here.
    await settle();

    expect(calls).toBe(2);
    expect((reader.result().data as Array<{ id: string }>).map(row => row.id)).toEqual(['chat-1']);
    // The refetch reopened the window: a second reader mounting inside it serves the same rows
    // without asking the server again.
    const second = renderCountedInProvider(() => Restarted.list({ statusFilter: 'active' }).use());
    await settle();
    expect(calls).toBe(2);
    expect((second.result().data as Array<{ id: string }>).map(row => row.id)).toEqual(['chat-1']);
    second.unmount();
    reader.unmount();
  });

  it('[P52] persists an app-shaped survivor chain as stale before a cold restart', async () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            chats: {
              nodes: calls === 1
                ? [
                    { id: 'chat-left', status: 'Secondary', lastActivityAt: '2026-08-02T00:00:00Z' },
                    { id: 'chat-kept', status: 'Secondary', lastActivityAt: '2026-08-01T00:00:00Z' }
                  ]
                : [{ id: 'chat-kept', status: 'Secondary', lastActivityAt: '2026-08-01T00:00:00Z' }],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          } as TData
        };
      }
    });
    configureDb({ storage, transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: FRESHNESS, onSyncError } });
    const Chat = defineChats('DurableScopeSurvivor');
    await bootDb();
    const relation = Chat.list({ statusFilter: 'Secondary' });
    await relation.fetch();
    const originalStamp = readOnlyQueryRecord(storage).dataUpdatedAt;

    Chat.update('chat-left', { status: 'Primary' });

    expect(readOnlyQueryRecord(storage)).toMatchObject({
      payload: { ids: [compositeKey('AppFreshnessChatDurableScopeSurvivor', 'chat-kept')] },
      empty: false,
      dataUpdatedAt: originalStamp,
      invalidated: true
    });

    configureDb({ storage, transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: FRESHNESS, onSyncError } });
    const Restarted = defineChats('DurableScopeSurvivor');
    await bootDb();
    const restarted = Restarted.list({ statusFilter: 'Secondary' });

    expect(restarted.read().map(row => row.id)).toEqual(['chat-kept']);
    await restarted.fetch();
    expect(calls).toBe(2);
    expect(onSyncError).not.toHaveBeenCalled();
  });

  it('persists an emptied app-shaped scope as stale before a cold restart', async () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            chats: {
              nodes: calls === 1 ? [{ id: 'chat-left', status: 'Secondary', lastActivityAt: '2026-08-01T00:00:00Z' }] : [],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          } as TData
        };
      }
    });
    configureDb({ storage, transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: FRESHNESS, onSyncError } });
    const Chat = defineChats('DurableScopeEmpty');
    await bootDb();
    await Chat.list({ statusFilter: 'Secondary' }).fetch();
    const originalStamp = readOnlyQueryRecord(storage).dataUpdatedAt;

    Chat.update('chat-left', { status: 'Primary' });

    expect(readOnlyQueryRecord(storage)).toMatchObject({ payload: { ids: [] }, empty: true, dataUpdatedAt: originalStamp, invalidated: true });

    configureDb({ storage, transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: FRESHNESS, onSyncError } });
    const Restarted = defineChats('DurableScopeEmpty');
    await bootDb();
    const restarted = Restarted.list({ statusFilter: 'Secondary' });

    expect(restarted.read()).toEqual([]);
    await restarted.fetch();
    expect(calls).toBe(2);
    expect(onSyncError).not.toHaveBeenCalled();
  });

  it('salvages materialization after a refused post-commit query rewrite', async () => {
    const baseStorage = createMemoryPlane();
    let refuseQueryRewrite = false;
    const storage = {
      ...baseStorage,
      set: (key: string, value: string | null): void => {
        if (refuseQueryRewrite && key.startsWith('dbl:query:')) throw new Error('query rewrite refused');
        baseStorage.set(key, value);
      }
    };
    const loggerError = jest.fn();
    const onSyncError = jest.fn((_error: Error, _context: { source: string; model?: string; key?: string }) => {
      throw new Error('observer refused the report');
    });
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            chats: {
              nodes: calls === 1 ? [{ id: 'chat-left', status: 'Secondary', lastActivityAt: '2026-08-01T00:00:00Z' }] : [],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          } as TData
        };
      }
    });
    configureDb({
      storage,
      transport,
      dataVersion: 'app-freshness',
      defaults: { freshnessClasses: FRESHNESS, onSyncError },
      logger: { debug: jest.fn(), error: loggerError }
    });
    const Chat = defineChats('DurableScopeRefusal');
    await bootDb();
    await Chat.list({ statusFilter: 'Secondary' }).fetch();

    refuseQueryRewrite = true;
    Chat.update('chat-left', { status: 'Primary' });
    refuseQueryRewrite = false;

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(onSyncError.mock.calls[0]![0]).toMatchObject({ message: 'query rewrite refused' });
    expect(onSyncError.mock.calls[0]![1]).toEqual({
      source: 'query',
      model: 'AppFreshnessChatDurableScopeRefusal',
      key: expect.stringMatching(/\S/)
    });
    expect(loggerError).toHaveBeenCalledWith('defineQuery onSyncError failed', { error: expect.objectContaining({ message: 'observer refused the report' }) });

    configureDb({ storage, transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: FRESHNESS, onSyncError } });
    const Restarted = defineChats('DurableScopeRefusal');
    await bootDb();
    const restarted = Restarted.list({ statusFilter: 'Secondary' });

    expect(restarted.read()).toEqual([]);
    await restarted.fetch();
    expect(calls).toBe(2);
    expect(onSyncError).toHaveBeenCalledTimes(1);
  });

  it('preserves the storage error when a landed query record write is refused', async () => {
    const baseStorage = createMemoryPlane();
    let refuseQueryWrite = false;
    const storage = {
      ...baseStorage,
      set: (key: string, value: string | null): void => {
        if (refuseQueryWrite && key.startsWith('dbl:query:')) throw new Error('landed query write refused');
        baseStorage.set(key, value);
      }
    };
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          chats: {
            nodes: [{ id: 'chat-kept', status: 'Secondary', lastActivityAt: '2026-08-01T00:00:00Z' }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        } as TData
      })
    });
    configureDb({ storage, transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: FRESHNESS } });
    const relation = defineChats('DurableScopeLandingRefusal').list({ statusFilter: 'Secondary' });
    await bootDb();

    refuseQueryWrite = true;
    try {
      await expect(relation.refresh()).rejects.toThrow('landed query write refused');
    } finally {
      refuseQueryWrite = false;
    }
  });

  it('A3 keeps every paged chat the user revealed when the window closes under a mounted reader', async () => {
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return { data: chatPage(served, served < 3) as TData };
      }
    });
    configure(createMemoryPlane(), transport);
    const Chat = defineChats('PagedRefresh');
    await bootDb();
    const reader = renderCountedInProvider(() => Chat.list({ statusFilter: 'active' }).use({ loadMoreDebounceMs: 0 }));
    await settle();
    await settle(1, { macro: true });
    act(() => reader.result().loadMore());
    await settle(1, { macro: true });
    act(() => reader.result().loadMore());
    await settle(1, { macro: true });
    expect(reader.result().data.map(row => row.id)).toEqual(['chat-3', 'chat-2', 'chat-1']);

    await act(async () => {
      await Chat.list({ statusFilter: 'active' }).refresh();
    });
    await settle(1, { macro: true });

    expect(reader.result().data.map(row => row.id)).toContain('chat-3');
    expect(reader.result().data.map(row => row.id)).toContain('chat-2');
    reader.unmount();
  });

  it('A4 keeps revealed thread history when an uncapped backward chain refreshes', async () => {
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return { data: threadPage(served, served < 3) as TData };
      }
    });
    configure(createMemoryPlane(), transport);
    const Message = defineMessages('ThreadRefresh');
    await bootDb();
    const reader = renderCountedInProvider(() => Message.thread({ chatId: 'chat-1' }).use({ loadMoreDebounceMs: 0 }));
    await settle();
    await settle(1, { macro: true });
    act(() => reader.result().loadMore());
    await settle(1, { macro: true });
    act(() => reader.result().loadMore());
    await settle(1, { macro: true });
    expect(reader.result().data).toHaveLength(3);

    await act(async () => {
      await Message.thread({ chatId: 'chat-1' }).refresh();
    });
    await settle(1, { macro: true });

    expect(reader.result().data.map(row => row.id)).toContain('m-2');
    expect(reader.result().data.map(row => row.id)).toContain('m-3');
    reader.unmount();
  });

  it('A5 retries an empty chat detail on the empty window, not on the push-backed one', async () => {
    jest.useFakeTimers();
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { chat: null } as TData };
      }
    });
    configure(storage, transport);
    const Chat = defineChats('EmptyRetry');
    await bootDb();
    await Chat.details({ chatId: 'chat-1' }).fetch();
    expect(calls).toBe(1);

    jest.advanceTimersByTime(FRESHNESS.EMPTY_RETRY - 1);
    await Chat.details({ chatId: 'chat-1' }).fetch();
    expect(calls).toBe(1);

    jest.advanceTimersByTime(2);
    await Chat.details({ chatId: 'chat-1' }).fetch();
    expect(calls).toBe(2);
  });

  it('A7 fetches a probe window once per mount instead of spinning under a mounted reader', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { chat: { id: 'chat-1', status: 'active', lastActivityAt: '2026-08-01T00:00:00Z' } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, dataVersion: 'app-freshness', defaults: { freshnessClasses: { ...FRESHNESS, PROBE: 0 } } });
    const Chat = defineModel('AppFreshnessChatProbe', {
      schema: ChatSchema,
      relations: owner => ({
        details: {
          remote: owner.gql.single(chatDocument, {
            variables: (params: { chatId: string }) => ({ id: params.chatId }),
            select: data => data.chat,
            staleTime: 'PROBE'
          })
        }
      })
    });
    await bootDb();
    const reader = renderCountedInProvider(() => Chat.details({ chatId: 'chat-1' }).use());
    await settle();
    await settle(1, { macro: true });
    const afterMount = calls;
    await settle(20);
    await settle(3, { macro: true });

    expect(afterMount).toBe(1);
    expect(calls).toBe(1);
    reader.unmount();
  });

  it('A8 catches up a backgrounded chat list on reconnect, where no scheduled refresh was pending', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: chatPage(1, false) as TData };
      }
    });
    configure(createMemoryPlane(), transport);
    const Chat = defineChats('Background');
    await bootDb();
    const reader = renderCountedInProvider(() => Chat.list({ statusFilter: 'active' }).use());
    await settleUntil(() => calls === 1);

    try {
      // Backgrounded: the scheduled refresh is suppressed, so nothing is pending to resume. The
      // window still closes while the app sits offline, and the reconnect is the only thing left
      // that can notice.
      focusManager.setFocused(false);
      await act(async () => {
        setFetchNetworkOnline(false);
      });
      jest.advanceTimersByTime(FRESHNESS.PUSH_BACKED + 1);
      await settle();
      expect(calls).toBe(1);

      await act(async () => {
        setFetchNetworkOnline(true);
      });
      await settleUntil(() => calls === 2);

      expect(calls).toBe(2);
    } finally {
      focusManager.setFocused(undefined);
      reader.unmount();
    }
  });

  it('A6 catches up a mounted chat list on reconnect when the window closed while offline', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: chatPage(1, false) as TData };
      }
    });
    configure(createMemoryPlane(), transport);
    const Chat = defineChats('Reconnect');
    await bootDb();
    const reader = renderCountedInProvider(() => Chat.list({ statusFilter: 'active' }).use());
    await settleUntil(() => calls === 1);

    // A reconnect on data still inside its window owes nothing.
    await act(async () => {
      setFetchNetworkOnline(false);
      setFetchNetworkOnline(true);
    });
    await settle();
    expect(calls).toBe(1);

    // Offline across the window boundary: the scheduled refresh cannot run, so the catch-up is the
    // reconnect's alone. Without it the screen keeps stale data until the next boundary.
    await act(async () => {
      setFetchNetworkOnline(false);
    });
    jest.advanceTimersByTime(FRESHNESS.PUSH_BACKED + 1);
    await settle();
    expect(calls).toBe(1);

    await act(async () => {
      setFetchNetworkOnline(true);
    });
    await settleUntil(() => calls === 2);

    expect(calls).toBe(2);
    reader.unmount();
  });
});
