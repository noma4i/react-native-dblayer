import { act } from 'react';
import { bootDb, configureDb, defineModelRuntime, f, type DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCountedInProvider, settle } from '../helpers/harness';

type MessageRow = {
  id: string;
  chatId: string;
  mediaBucket: string | null;
};

type ThreadScope = { chatId: string };
type MediaScope = { chatId: string; mediaBucket: string };
type MessageResponse = { messages: MessageRow[] };

const document = { kind: 'Document', definitions: [] } as never;

const createMessageModel = () =>
  defineModelRuntime({
    id: 'SpecConsumerPartialInvalidationMessages',
    name: 'SpecConsumerPartialInvalidationMessages',
    fields: {
      id: f.id(),
      chatId: f.id(),
      mediaBucket: f.str().nullable()
    },
    scopes: {
      thread: ({ by: { chatId: 'chatId' } }),
      mediaItems: ({ by: { chatId: 'chatId', mediaBucket: 'mediaBucket' } })
    }
  });

const createQueries = (messages: ReturnType<typeof createMessageModel>) => ({
  thread: messages.query<MessageResponse, ThreadScope, ThreadScope, MessageRow>('partial-invalidation-thread', {
    document,
    vars: scope => scope,
    select: data => data.messages,
    into: messages.scopes.thread,
    staleTime: Number.MAX_SAFE_INTEGER
  }),
  mediaItems: messages.query<MessageResponse, MediaScope, MediaScope, MessageRow>('partial-invalidation-media', {
    document,
    vars: scope => scope,
    select: data => data.messages,
    into: messages.scopes.mediaItems,
    staleTime: Number.MAX_SAFE_INTEGER
  })
});

describe('partial model invalidation', () => {
  it('uses one codec-normalized scope for transport, query identity, and model landing', async () => {
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => ({
        data: {
          messages: [{ id: 'message-1', chatId: (operation.variables as ThreadScope).chatId, mediaBucket: null }]
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessageModel();
    const queries = createQueries(messages);

    const reader = renderCountedInProvider(() => {
      queries.thread.use({ chatId: 42 } as never);
      return queries.thread.use({ chatId: '42' });
    });
    await settle();
    const initialCalls = [...transport.calls];
    act(() => {
      queries.thread.invalidate();
    });
    await settle();
    const invalidatedCalls = [...transport.calls];
    const ids = messages.scopes.thread.read({ chatId: '42' }).map(row => row.id);
    reader.unmount();

    expect(initialCalls).toHaveLength(1);
    expect(invalidatedCalls).toHaveLength(2);
    expect((invalidatedCalls[0] as { operation: { variables: unknown } } | undefined)?.operation.variables).toEqual({ chatId: '42' });
    expect((invalidatedCalls[1] as { operation: { variables: unknown } } | undefined)?.operation.variables).toEqual({ chatId: '42' });
    expect(ids).toEqual(['message-1']);
  });

  it('[F11] refetches only relations whose by keys are covered by the partial value', async () => {
    const fetches = { thread: 0, mediaItems: 0 };
    const transport = createMockTransport({
      query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => {
        const scope = operation.variables as ThreadScope & Partial<MediaScope>;
        const target = scope.mediaBucket === undefined ? 'thread' : 'mediaItems';
        fetches[target] += 1;
        return {
          data: {
            messages: [
              {
                id: `${target}-${fetches[target]}`,
                chatId: scope.chatId,
                mediaBucket: scope.mediaBucket ?? null
              }
            ]
          } as TData
        };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = createMessageModel();
    const queries = createQueries(messages);
    const threadReader = renderCountedInProvider(() => queries.thread.use({ chatId: '42' }));
    const mediaReader = renderCountedInProvider(() => queries.mediaItems.use({ chatId: '42', mediaBucket: 'visual' }));
    await settle();
    expect(fetches).toEqual({ thread: 1, mediaItems: 1 });

    let invalidationError: unknown;
    try {
      act(() => {
        messages.invalidate({ chatId: 42 });
      });
    } catch (error) {
      invalidationError = error;
    }
    await settle();
    threadReader.unmount();
    mediaReader.unmount();

    expect(invalidationError).toBeUndefined();
    expect(fetches).toEqual({ thread: 2, mediaItems: 1 });
  });

  it('[F4] throws on an invalidation whose address matches no declared relation', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const messages = createMessageModel();
    createQueries(messages);

    expect(() => {
      messages.invalidate({ threadBucket: 'unknown' });
    }).toThrow();
  });

  it('[F12] fans a partial invalidation out to persisted scopes with no mounted readers after a restart', async () => {
    const storage = createMemoryPlane();
    const fetches = { thread: 0, mediaItems: 0 };
    const createCountingTransport = () =>
      createMockTransport({
        query: async <TData,>(operation: Parameters<DbTransport['query']>[0]) => {
          const scope = operation.variables as ThreadScope & Partial<MediaScope>;
          const target = scope.mediaBucket === undefined ? 'thread' : 'mediaItems';
          fetches[target] += 1;
          return {
            data: {
              messages: [
                {
                  id: `${target}-${fetches[target]}`,
                  chatId: scope.chatId,
                  mediaBucket: scope.mediaBucket ?? null
                }
              ]
            } as TData
          };
        }
      });
    configureDb({ storage, transport: createCountingTransport() });
    const messages = createMessageModel();
    const queries = createQueries(messages);
    const threadReader = renderCountedInProvider(() => queries.thread.use({ chatId: '42' }));
    const mediaReader = renderCountedInProvider(() => queries.mediaItems.use({ chatId: '42', mediaBucket: 'visual' }));
    await settle();
    expect(fetches).toEqual({ thread: 1, mediaItems: 1 });
    threadReader.unmount();
    mediaReader.unmount();

    const restartedTransport = createCountingTransport();
    configureDb({ storage, transport: restartedTransport });
    const restartedMessages = createMessageModel();
    const restartedQueries = createQueries(restartedMessages);
    await act(async () => {
      await bootDb();
    });

    act(() => {
      restartedMessages.invalidate({ chatId: '42' });
    });
    await settle();
    expect(restartedTransport.calls).toHaveLength(0);

    const restartedThreadReader = renderCountedInProvider(() => restartedQueries.thread.use({ chatId: '42' }));
    await settle();
    expect(fetches).toEqual({ thread: 2, mediaItems: 1 });

    const restartedMediaReader = renderCountedInProvider(() => restartedQueries.mediaItems.use({ chatId: '42', mediaBucket: 'visual' }));
    await settle();
    expect(fetches).toEqual({ thread: 2, mediaItems: 1 });
    restartedThreadReader.unmount();
    restartedMediaReader.unmount();
  });
});
