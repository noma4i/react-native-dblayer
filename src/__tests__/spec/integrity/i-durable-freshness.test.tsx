import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import {
  configureDb,
  compositeKey,
  compositeStorageKey,
  defineFetch,
  defineModel,
  defineShape,
  encodePersistence,
  f,
  getDbQueryClient,
  gql,
  type QueryPersistenceRecord,
  suspendDb
} from '../../testApi';
import { bootDb } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type FetchPayload = { value: string };
type MessageInput = { id: string; chatId: string; body: string };
type ThreadData = {
  messages: {
    nodes: MessageInput[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};
type ThreadVariables = { chatId: string; after?: string | null };
type DetailData = { message: MessageInput | null };
type DetailVariables = { id: string };

const threadDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ThreadData, ThreadVariables>;
const detailDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<DetailData, DetailVariables>;
const MessageSchema = defineShape<MessageInput>()({
  chatId: f.id(),
  body: f.str()
});

const configure = (storage: ReturnType<typeof createMemoryPlane>, transport = createMockTransport()): void => {
  configureDb({
    storage,
    transport,
    dataVersion: 'durable-freshness',
    defaults: { staleTime: 1_000, emptyStaleTime: 5_000, inSessionGc: false }
  });
};

const rewriteQueryRecord = (
  storage: ReturnType<typeof createMemoryPlane>,
  update: (record: QueryPersistenceRecord) => QueryPersistenceRecord
): void => {
  const key = storage.snapshotKeys().find(candidate => candidate.startsWith('dbl:query:'));
  if (key === undefined) throw new Error('query record is missing');
  const envelope = JSON.parse(storage.get(key)!) as { payload: QueryPersistenceRecord };
  storage.set([{ key, value: encodePersistence(update(envelope.payload)) }]);
};

describe('durable freshness', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('restores a fresh named fetch with its original timestamp and without transport', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const storage = createMemoryPlane();
    let calls = 0;
    configure(storage);
    const request = defineFetch<FetchPayload, string, string>({
      key: 'durable-fetch-fresh',
      fetcher: async input => ({ value: `${input}-${++calls}` }),
      select: data => data.value,
      staleTime: 1_000
    });

    await expect(request.fetch('scope')).resolves.toBe('scope-1');
    jest.advanceTimersByTime(999);
    configure(storage);

    expect(request.read('scope')).toBe('scope-1');
    await expect(request.fetch('scope')).resolves.toBe('scope-1');
    expect(calls).toBe(1);
  });

  it('refetches an expired named fetch exactly once after restart', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const storage = createMemoryPlane();
    let calls = 0;
    configure(storage);
    const request = defineFetch<FetchPayload, string, string>({
      key: 'durable-fetch-expired',
      fetcher: async input => ({ value: `${input}-${++calls}` }),
      select: data => data.value,
      staleTime: 1_000
    });

    await request.fetch('scope');
    jest.advanceTimersByTime(1_001);
    configure(storage);

    await expect(Promise.all([request.fetch('scope'), request.fetch('scope')])).resolves.toEqual(['scope-2', 'scope-2']);
    expect(calls).toBe(2);
  });

  it('uses emptyStaleTime for a restored empty selected value', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const storage = createMemoryPlane();
    let calls = 0;
    configure(storage);
    const request = defineFetch<FetchPayload, void, string[]>({
      key: 'durable-fetch-empty',
      fetcher: async () => ({ value: String(++calls) }),
      select: () => [],
      staleTime: 1_000,
      emptyStaleTime: 5_000
    });

    await request.fetch();
    jest.advanceTimersByTime(4_999);
    configure(storage);

    await expect(request.fetch()).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  it('keeps runtime-zero and anonymous fetches process-local', async () => {
    const storage = createMemoryPlane();
    let zeroCalls = 0;
    let anonymousCalls = 0;
    configure(storage);
    const zero = defineFetch<FetchPayload, void, string>({
      key: 'durable-fetch-zero',
      fetcher: async () => ({ value: String(++zeroCalls) }),
      select: data => data.value,
      staleTime: 0
    });
    const anonymous = defineFetch<FetchPayload, void, string>({
      fetcher: async () => ({ value: String(++anonymousCalls) }),
      select: data => data.value,
      staleTime: 1_000
    });

    await zero.fetch();
    await anonymous.fetch();
    configure(storage);
    await zero.fetch();
    await anonymous.fetch();

    expect({ zeroCalls, anonymousCalls }).toEqual({ zeroCalls: 2, anonymousCalls: 2 });
  });

  it('validates restored selected data and removes the rejected record', async () => {
    const storage = createMemoryPlane();
    configure(storage);
    const first = defineFetch<FetchPayload, void, string>({
      key: 'durable-fetch-validation',
      fetcher: async () => ({ value: 'unsafe' }),
      select: data => data.value,
      staleTime: 1_000
    });
    await first.fetch();

    configure(storage);
    const second = defineFetch<FetchPayload, void, string>({
      key: 'durable-fetch-validation',
      fetcher: async () => ({ value: 'safe' }),
      select: data => data.value,
      validate: selected => {
        if (selected !== 'safe') throw new Error('rejected restore');
        return selected;
      },
      staleTime: 1_000
    });

    expect(second.read()).toBeUndefined();
    await expect(second.fetch()).resolves.toBe('safe');
  });

  it('rejects a persisted input mismatch and a now-process-local freshness policy', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    configure(storage);
    const first = defineFetch<FetchPayload, string, string>({
      key: 'durable-fetch-policy-change',
      fetcher: async () => ({ value: String(++calls) }),
      select: data => data.value,
      staleTime: 1_000
    });
    await first.fetch('scope');
    rewriteQueryRecord(storage, record => ({ ...record, scope: 'other-scope' }));

    configure(storage);
    expect(first.read('scope')).toBeUndefined();
    await first.fetch('scope');
    configure(storage);
    const processLocal = defineFetch<FetchPayload, string, string>({
      key: 'durable-fetch-policy-change',
      fetcher: async () => ({ value: String(++calls) }),
      select: data => data.value,
      staleTime: 0
    });

    expect(processLocal.read('scope')).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('restores invalidated data as stale and validates transport data', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const onSyncError = jest.fn();
    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { staleTime: 1_000, inSessionGc: false, onSyncError }
    });
    const first = defineFetch<FetchPayload, void, string>({
      key: 'durable-fetch-invalidated',
      fetcher: async () => ({ value: String(++calls) }),
      select: data => data.value,
      staleTime: 1_000
    });
    await first.fetch();
    rewriteQueryRecord(storage, record => ({ ...record, invalidated: true }));

    configureDb({
      storage,
      transport: createMockTransport(),
      defaults: { staleTime: 1_000, inSessionGc: false, onSyncError }
    });
    expect(first.read()).toBe('1');
    await expect(first.fetch()).resolves.toBe('2');
    const rejected = defineFetch<FetchPayload, void, string>({
      key: 'durable-fetch-network-validation',
      fetcher: async () => ({ value: 'unsafe' }),
      select: data => data.value,
      validate: () => {
        throw new Error('unsafe transport value');
      },
      staleTime: 1_000
    });

    await expect(rejected.fetch()).rejects.toThrow('unsafe transport value');
    expect(onSyncError).toHaveBeenCalledTimes(1);
  });

  it('separates freshness-aware fetch, forced refresh, and family removal', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    configure(storage);
    const request = defineFetch<FetchPayload, void, string>({
      key: 'durable-fetch-controls',
      fetcher: async () => ({ value: String(++calls) }),
      select: data => data.value,
      staleTime: 1_000
    });

    await expect(request.fetch()).resolves.toBe('1');
    await expect(request.fetch()).resolves.toBe('1');
    await expect(request.refresh()).resolves.toBe('2');
    request.remove();
    configure(storage);

    expect(request.read()).toBeUndefined();
    await expect(request.fetch()).resolves.toBe('3');
  });

  it('restores model relation rows and pagination metadata before freshness evaluation', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            messages: {
              nodes: [{ id: `m-${calls}`, chatId: 'chat-1', body: `body-${calls}` }],
              pageInfo: { hasNextPage: calls === 1, endCursor: calls === 1 ? 'cursor-1' : null }
            }
          } as TData
        };
      }
    });
    configure(storage, transport);
    const Message = defineModel('DurableFreshnessMessage', {
      schema: MessageSchema,
      relations: {
        thread: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 1_000
          })
        }
      }
    });
    await bootDb();
    await Message.thread({ chatId: 'chat-1' }).fetch();
    suspendDb();
    jest.advanceTimersByTime(999);

    configure(storage, transport);
    await bootDb();
    const relation = Message.thread({ chatId: 'chat-1' });

    expect(relation.read().map(row => row.id)).toEqual(['m-1']);
    await relation.fetch();
    expect(calls).toBe(1);
    await relation.refresh();
    expect(calls).toBe(2);
  });

  it('persists named relation family invalidation without touching sibling relations', async () => {
    const storage = createMemoryPlane();
    const callsByChat = new Map<string, number>();
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        const chatId = String((operation.variables as { chatId: string }).chatId);
        const calls = (callsByChat.get(chatId) ?? 0) + 1;
        callsByChat.set(chatId, calls);
        return {
          data: {
            messages: {
              nodes: [{ id: `${chatId}-${calls}`, chatId, body: `${chatId}-${calls}` }],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          } as TData
        };
      }
    });
    configure(storage, transport);
    const Message = defineModel('DurableFreshnessFamily', {
      schema: MessageSchema,
      relations: {
        thread: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 10_000
          })
        },
        sibling: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 10_000
          })
        }
      }
    });
    await bootDb();
    await Message.thread({ chatId: 'chat-1' }).fetch();
    await Message.thread({ chatId: 'chat-2' }).fetch();
    await Message.sibling({ chatId: 'chat-3' }).fetch();
    suspendDb();

    configure(storage, transport);
    await bootDb();
    Message.thread.invalidate();
    configure(storage, transport);
    await bootDb();
    await Message.thread({ chatId: 'chat-1' }).fetch();
    await Message.thread({ chatId: 'chat-2' }).fetch();
    await Message.sibling({ chatId: 'chat-3' }).fetch();

    expect(Object.fromEntries(callsByChat)).toEqual({ 'chat-1': 2, 'chat-2': 2, 'chat-3': 1 });
  });

  it('rejects incompatible scope destinations and malformed metadata before freshness evaluation', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            messages: {
              nodes: [{ id: `m-${calls}`, chatId: 'chat-1', body: `body-${calls}` }],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          } as TData
        };
      }
    });
    configure(storage, transport);
    const Message = defineModel('DurableFreshnessDestinationValidation', {
      schema: MessageSchema,
      relations: {
        thread: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 1_000
          })
        }
      }
    });
    await bootDb();
    const relation = Message.thread({ chatId: 'chat-1' });
    await relation.fetch();
    suspendDb();

    rewriteQueryRecord(storage, record => ({
      ...record,
      payload: {
        ...(record.payload as Record<string, unknown>),
        ids: [compositeKey('WrongDestination', 'm-1')]
      }
    }));
    configure(storage, transport);
    await bootDb();
    await relation.fetch();
    expect(calls).toBe(2);
    suspendDb();

    const scopePrefix = compositeStorageKey('dbl:', 'scope', 'DurableFreshnessDestinationValidation');
    storage.set(storage.keys(scopePrefix).map(key => ({ key, value: null })));
    configure(storage, transport);
    await bootDb();
    await relation.fetch();
    expect(calls).toBe(3);
    suspendDb();

    relation.seed([
      ...relation.read(),
      { id: 'keep-row', chatId: 'chat-1', body: 'keep' }
    ]);
    suspendDb();
    storage.set([
      {
        key: compositeStorageKey('dbl:', 'row', 'DurableFreshnessDestinationValidation', 'm-3'),
        value: null
      }
    ]);
    configure(storage, transport);
    await bootDb();
    await relation.fetch();
    expect(calls).toBe(4);
    rewriteQueryRecord(storage, record => ({ ...record, payload: {} }));
    configure(storage, transport);
    await bootDb();
    await relation.fetch();
    expect(calls).toBe(5);
    await expect(Message.thread(null).refresh()).resolves.toBeUndefined();

    suspendDb();
    rewriteQueryRecord(storage, record => ({ ...record, scope: { chatId: null } }));
    configure(storage, transport);
    await bootDb();
    expect(() => Message.thread({ chatId: 'other-chat' }).invalidate()).not.toThrow();
  });

  it('rejects a missing direct-model destination row and a disabled durable policy', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            message: { id: 'm-1', chatId: 'chat-1', body: `body-${calls}` }
          } as TData
        };
      }
    });
    configureDb({
      storage,
      transport,
      dataVersion: 'durable-freshness',
      defaults: {
        freshnessClasses: { durable: 1_000 },
        inSessionGc: false
      }
    });
    const Message = defineModel('DurableFreshnessDirectDestination', {
      schema: MessageSchema,
      relations: {
        details: {
          remote: gql.single(detailDocument, {
            variables: ({ id }: { id: string }) => ({ id }),
            select: data => data.message,
            staleTime: 'durable'
          })
        }
      }
    });
    await bootDb();
    const details = Message.details({ id: 'm-1' });
    await details.fetch();
    suspendDb();

    const rowPrefix = compositeStorageKey('dbl:', 'row', 'DurableFreshnessDirectDestination');
    storage.set(storage.keys(rowPrefix).map(key => ({ key, value: null })));
    configureDb({
      storage,
      transport,
      dataVersion: 'durable-freshness',
      defaults: {
        freshnessClasses: { durable: 1_000 },
        inSessionGc: false
      }
    });
    const MessageAfterRestart = defineModel('DurableFreshnessDirectDestination', {
      schema: MessageSchema,
      relations: {
        details: {
          remote: gql.single(detailDocument, {
            variables: ({ id }: { id: string }) => ({ id }),
            select: data => data.message,
            staleTime: 'durable'
          })
        }
      }
    });
    await bootDb();
    expect(storage.snapshotKeys().filter(key => key.startsWith('dbl:query:'))).toHaveLength(1);
    await MessageAfterRestart.details({ id: 'm-1' }).fetch();
    expect(calls).toBe(2);
  });

  it('drops restored query metadata when its named freshness class becomes process-local', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const freshnessClasses = { durable: 1_000 };
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return {
          data: {
            message: { id: 'm-1', chatId: 'chat-1', body: `body-${calls}` }
          } as TData
        };
      }
    });
    configureDb({
      storage,
      transport,
      dataVersion: 'durable-freshness',
      defaults: {
        freshnessClasses,
        inSessionGc: false
      }
    });
    const Message = defineModel('DurableFreshnessProcessLocalPolicy', {
      schema: MessageSchema,
      relations: {
        details: {
          remote: gql.single(detailDocument, {
            variables: ({ id }: { id: string }) => ({ id }),
            select: data => data.message,
            staleTime: 'durable'
          })
        }
      }
    });
    await bootDb();
    const processLocalDetails = Message.details({ id: 'm-1' });
    await processLocalDetails.fetch();
    getDbQueryClient().removeQueries();
    freshnessClasses.durable = 0;

    processLocalDetails.read();
    await processLocalDetails.fetch();
    expect(calls).toBe(2);
  });
});
