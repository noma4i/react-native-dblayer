import { act } from 'react';
import { bootDb, configureDb, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, recordTimelineInProvider, settle } from '../helpers/harness';
import { createAppModels } from './appModels';

const document = { kind: 'Document', definitions: [] } as never;

const HEAD_PAGE = 25;

type ThreadConnection = { nodes: Array<Record<string, unknown>>; pageInfo: { hasPreviousPage: boolean; startCursor: string | null } };
type ThreadResponse = { chat: { messages: ThreadConnection | null } };
type ChatListResponse = { chats: { nodes: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };

const stamp = (seq: number): string => `2026-07-27T00:${String(seq).padStart(2, '0')}:00Z`;

const threadMessage = (seq: number) => ({
  id: `m-${seq}`,
  chatId: 'chat-1',
  userId: 'other',
  body: `body-${seq}`,
  kind: 'text' as const,
  status: 'Sent' as const,
  createdAt: stamp(seq),
  updatedAt: stamp(seq),
  sequenceNumber: seq,
  mediaGroupId: null,
  replyToId: null,
  media: null,
  localPreviewUrl: null
});

/** The chat-list fragment of the newest message: the server node carries NO chatId string. */
const lastMessageNode = () => {
  const { chatId: _chatId, ...node } = threadMessage(HEAD_PAGE);
  return node;
};

const chatRow = () => ({
  id: 'chat-1', uuid: null, kind: 'personal' as const, status: 'active' as const, premium: false, name: null, logoUrl: null, description: null,
  isPublic: false, history: 'all' as const, pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: HEAD_PAGE, lastActivityAt: stamp(HEAD_PAGE),
  lastMessageAt: stamp(HEAD_PAGE), lastSequenceNumber: HEAD_PAGE, lastMessage: lastMessageNode(), readMarksSummary: null, summary: null, connectionStatus: null,
  userIds: [], ownerId: null, createdAt: stamp(1), updatedAt: stamp(HEAD_PAGE)
});

const chatListResponse = (): ChatListResponse => ({ chats: { nodes: [chatRow()], pageInfo: { hasNextPage: false, endCursor: null } } });

const threadResponse = (rows: Array<Record<string, unknown>>): ThreadResponse => ({
  chat: { messages: { nodes: rows, pageInfo: { hasPreviousPage: false, startCursor: null } } }
});

const headRows = (): Array<Record<string, unknown>> => Array.from({ length: HEAD_PAGE }, (_, index) => threadMessage(index + 1));

const declareQueries = (models: ReturnType<typeof createAppModels>) => {
  const chatListQuery = models.chats.query('list', {
    document,
    vars: (scope: { statusFilter: string }) => ({ statusFilter: scope.statusFilter }),
    page: (data: ChatListResponse) => data.chats,
    into: models.chats.scopes.list,
    coverage: 'page',
    staleTime: 300_000
  });
  const threadQuery = models.messages.query('thread', {
    document,
    vars: (scope: { chatId: string }) => ({ chatId: scope.chatId, last: HEAD_PAGE }),
    page: (data: ThreadResponse) => data.chat.messages,
    into: models.messages.scopes.thread,
    coverage: 'page',
    direction: 'backward',
    staleTime: 300_000
  });
  return { chatListQuery, threadQuery };
};

const threadIds = (models: ReturnType<typeof createAppModels>): string[] =>
  models.messages.scopes.thread.read({ chatId: 'chat-1' }).map((row: any) => row.id);

/**
 * The fresh-login battle sequence, exactly as the device runs it: one runtime, one storage plane,
 * a real boot on an empty disk, the chat list landing chats with a sideloaded lastMessage, then the
 * thread head page (coverage page, backward, last:25) rendered through the scope window. The suite
 * exists because a device showed a thread rendering ONLY its lastMessage while the server held the
 * whole day - each discriminator below names the candidate mechanism it guards.
 */
describe('app-shaped fresh login thread window', () => {
  it('[F50] renders the full head window after a fresh login: sideloaded lastMessage plus page rows, chronological, no holes', async () => {
    const storage = createMemoryPlane();
    let chatCalls = 0;
    let threadCalls = 0;
    configureDb({
      storage,
      transport: createMockTransport({
        query: async <TData,>(operation: { variables?: unknown }) => {
          const variables = operation.variables as Record<string, unknown>;
          if ('statusFilter' in variables) {
            chatCalls += 1;
            return { data: chatListResponse() as TData };
          }
          threadCalls += 1;
          return { data: threadResponse(headRows()) as TData };
        }
      })
    });
    const models = createAppModels('FreshLoginF50');
    const { chatListQuery, threadQuery } = declareQueries(models);
    await act(async () => {
      await bootDb();
    });

    // Chat list screen: the landing carries the chat AND its lastMessage sideload (string chatId).
    await chatListQuery.fetch({ statusFilter: 'active' });
    expect(chatCalls).toBe(1);
    expect(models.chats.scopes.list.read({ statusFilter: 'active' }).map((row: any) => row.id)).toEqual(['chat-1']);
    expect(models.messages.find(`m-${HEAD_PAGE}`)).toMatchObject({ chatId: 'chat-1', sequenceNumber: HEAD_PAGE });
    expect(threadIds(models)).toEqual([`m-${HEAD_PAGE}`]);

    // Open the thread: head-page connection fetch renders through the scope window.
    const reader = recordTimelineInProvider(() => threadQuery.use({ chatId: 'chat-1' }));
    const windowReader = recordTimelineInProvider(() => models.messages.scopes.thread.useWindow({ chatId: 'chat-1' }, { pageSize: HEAD_PAGE }));
    await settle();
    await settle(1, { macro: true });

    const windowRows = windowReader.last().rows as Array<{ id: string; sequenceNumber: number }>;
    expect(windowRows).toHaveLength(HEAD_PAGE);
    // Chronological and hole-free: the window is the contiguous newest-first head of the thread.
    expect(windowRows.map(row => row.sequenceNumber)).toEqual(Array.from({ length: HEAD_PAGE }, (_, index) => HEAD_PAGE - index));
    // The sideloaded lastMessage and the page copy of the same server id are ONE row.
    expect(windowRows.filter(row => row.id === `m-${HEAD_PAGE}`)).toHaveLength(1);
    expect((reader.last().data as Array<{ id: string }>)).toHaveLength(HEAD_PAGE);
    expect(threadCalls).toBe(1);
    reader.unmount();
    windowReader.unmount();

    // Chain health: a remount inside the freshness window serves the same head without new network.
    const remount = recordTimelineInProvider(() => threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    await settle(1, { macro: true });
    expect((remount.last().data as Array<{ id: string }>)).toHaveLength(HEAD_PAGE);
    expect(threadCalls).toBe(1);
    remount.unmount();

    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('[F51] documents the tombstone gate fingerprint: snapshot re-land is gated and counted, the EVENT-origin lastMessage resurrects alone', async () => {
    const storage = createMemoryPlane();
    let threadCalls = 0;
    configureDb({
      storage,
      transport: createMockTransport({
        query: async <TData,>(operation: { variables?: unknown }) => {
          const variables = operation.variables as Record<string, unknown>;
          if ('statusFilter' in variables) return { data: chatListResponse() as TData };
          threadCalls += 1;
          return { data: threadResponse(headRows()) as TData };
        }
      })
    });
    const models = createAppModels('FreshLoginF51');
    const { chatListQuery, threadQuery } = declareQueries(models);
    await act(async () => {
      await bootDb();
    });
    await chatListQuery.fetch({ statusFilter: 'active' });
    await threadQuery.fetch({ chatId: 'chat-1' });
    expect(threadIds(models)).toHaveLength(HEAD_PAGE);

    // App-shaped transient destroy of the chat: the hasMany dependent-destroy cascade tombstones
    // every thread row.
    const dropsBefore = diagnostics().snapshot().tombstoneWriteDrops;
    models.chats.destroy('chat-1');
    expect(threadIds(models)).toEqual([]);

    // The server still holds the whole day and re-lands the thread through the snapshot channel:
    // the tombstone gate stands before planning, so every page row is dropped and counted.
    await threadQuery.refresh({ chatId: 'chat-1' });
    expect(threadCalls).toBe(2);
    expect(diagnostics().snapshot().tombstoneWriteDrops - dropsBefore).toBe(HEAD_PAGE);
    expect(threadIds(models)).toEqual([]);

    // The live chatUpdated event re-lands the chat with its lastMessage sideload: the EVENT origin
    // passes the tombstone gate, so exactly the lastMessage resurrects - the device fingerprint
    // "only lastMessage visible". Documented per current spec; a min-age fork is an owner decision.
    models.chats.insert(chatRow());
    expect(threadIds(models)).toEqual([`m-${HEAD_PAGE}`]);
    expect(models.chats.find('chat-1')).toMatchObject({ lastMessageId: `m-${HEAD_PAGE}` });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('[F52] a reset of one thread declaration during the head fetch of another neither swallows the landing nor fabricates a fresh-empty record', async () => {
    const storage = createMemoryPlane();
    const resolvers = new Map<string, (data: ThreadResponse) => void>();
    configureDb({
      storage,
      transport: createMockTransport({
        query: async <TData,>(operation: { variables?: unknown }) =>
          new Promise<{ data: TData }>(resolve => {
            const which = (operation.variables as { which: string }).which;
            resolvers.set(which, data => resolve({ data: data as TData }));
          })
      })
    });
    const models = createAppModels('FreshLoginF52');
    const threadHead = models.messages.query('thread', {
      document,
      key: 'f52-head',
      vars: (scope: { chatId: string }) => ({ chatId: scope.chatId, last: HEAD_PAGE, which: 'head' }),
      page: (data: ThreadResponse) => data.chat.messages,
      into: models.messages.scopes.thread,
      coverage: 'page',
      direction: 'backward',
      staleTime: 300_000
    });
    const threadSync = models.messages.query('thread', {
      document,
      key: 'f52-sync',
      vars: (scope: { chatId: string }) => ({ chatId: scope.chatId, which: 'sync' }),
      page: (data: ThreadResponse) => data.chat.messages,
      into: models.messages.scopes.thread,
      coverage: 'page',
      direction: 'backward',
      staleTime: 300_000
    });
    await act(async () => {
      await bootDb();
    });

    // The head fetch is in flight when the sync declaration resets the same destination scope.
    const first = threadHead.refresh({ chatId: 'chat-1' });
    await settle(2);
    expect(resolvers.has('head')).toBe(true);
    const second = threadSync.refresh({ chatId: 'chat-1' });
    await settle(2);
    expect(resolvers.has('sync')).toBe(true);
    resolvers.get('sync')!(threadResponse([threadMessage(HEAD_PAGE)]));
    await second;
    resolvers.get('head')!(threadResponse(headRows()));
    await first;

    // No fabricated fresh-empty chain reached the disk for either declaration.
    const persisted = storage
      .snapshotKeys()
      .filter(key => key.includes('f52-'))
      .map(key => JSON.parse(storage.get(key)!) as { payload: { empty?: boolean; payload?: { ids?: string[] } } });
    expect(persisted.filter(envelope => envelope.payload.empty === true)).toEqual([]);
    expect(persisted.filter(envelope => envelope.payload.payload?.ids?.length === 0)).toEqual([]);
    // The head landing survives the racing reset: the thread refetched and holds the full window.
    expect(threadIds(models)).toHaveLength(HEAD_PAGE);
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('[F53] refuses a null thread connection and keeps the sideloaded member', async () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
    configureDb({
      storage,
      defaults: { onSyncError },
      transport: createMockTransport({
        query: async <TData,>(operation: { variables?: unknown }) => {
          const variables = operation.variables as Record<string, unknown>;
          if ('statusFilter' in variables) return { data: chatListResponse() as TData };
          return { data: { chat: { messages: null } } as TData };
        }
      })
    });
    const models = createAppModels('FreshLoginF53');
    const { chatListQuery, threadQuery } = declareQueries(models);
    await act(async () => {
      await bootDb();
    });
    await chatListQuery.fetch({ statusFilter: 'active' });
    expect(threadIds(models)).toEqual([`m-${HEAD_PAGE}`]);

    // The nullish connection is a refused landing, not an empty thread.
    await expect(threadQuery.fetch({ chatId: 'chat-1' })).rejects.toThrow('no usable pageInfo');

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(threadIds(models)).toEqual([`m-${HEAD_PAGE}`]);
    expect(models.messages.find(`m-${HEAD_PAGE}`)).toMatchObject({ sequenceNumber: HEAD_PAGE });
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('[F54] a zombie thread reader of session A does not land its flight into session B on the same plane', async () => {
    const storage = createMemoryPlane();
    let threadResolverA: ((data: ThreadResponse) => void) | undefined;
    configureDb({
      storage,
      transport: createMockTransport({
        query: async <TData,>(operation: { variables?: unknown }) => {
          const variables = operation.variables as Record<string, unknown>;
          if ('statusFilter' in variables) return { data: chatListResponse() as TData };
          return new Promise<{ data: TData }>(resolve => {
            threadResolverA = data => resolve({ data: data as TData });
          });
        }
      })
    });
    const models = createAppModels('FreshLoginF54');
    const { chatListQuery, threadQuery } = declareQueries(models);
    await act(async () => {
      await bootDb();
    });
    await chatListQuery.fetch({ statusFilter: 'active' });
    const reader = recordTimelineInProvider(() => threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    expect(threadResolverA).toBeDefined();

    // Logout while the thread screen is still mounted and its head fetch is still in flight.
    act(() => {
      resetRuntime();
    });
    const framesAtReset = reader.frames().length;

    // Session B continues in the same process on the same plane; its server has no such thread.
    const transportB = createMockTransport({
      query: async <TData,>(operation: { variables?: unknown }) => {
        const variables = operation.variables as Record<string, unknown>;
        if ('statusFilter' in variables) return { data: { chats: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } as TData };
        return { data: threadResponse([]) as TData };
      }
    });
    configureDb({ storage, transport: transportB });
    await act(async () => {
      await bootDb();
    });
    await settle();
    await settle(1, { macro: true });

    // Session A's zombie flight resolves after B booted: its landing must be discarded.
    threadResolverA!(threadResponse(headRows()));
    await settle();
    await settle(1, { macro: true });

    // No cross-session contamination: A's rows never materialize in B, in memory or on disk.
    expect(threadIds(models)).toEqual([]);
    expect(models.messages.find(`m-${HEAD_PAGE}`)).toBeUndefined();
    for (const frame of reader.frames().slice(framesAtReset)) {
      expect(((frame.data ?? []) as Array<{ id: string }>).filter(row => row.id.startsWith('m-'))).toEqual([]);
    }
    const persistedThreadRecords = storage
      .snapshotKeys()
      .filter(key => key.startsWith('dbl:query:'))
      .map(key => JSON.parse(storage.get(key)!) as { payload: { payload?: { ids?: string[] } } });
    for (const record of persistedThreadRecords) {
      expect((record.payload.payload?.ids ?? []).filter(id => id.includes('m-'))).toEqual([]);
    }
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
    reader.unmount();
  });
});
