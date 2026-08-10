import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import {
  configureDb,
  compositeKey,
  compositeStorageKey,
  defineModel,
  defineShape,
  encodePersistence,
  f,
  getDbQueryClient,
  type QueryPersistenceRecord
} from '../../testApi';
import { bootDb, getApplyRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type FetchPayload = { value: string };
type FetchVariables = { scope?: string };
type FetchRow = { id: string; value: string };
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
const fetchDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<FetchPayload, FetchVariables>;
const MessageSchema = defineShape<MessageInput>()({
  chatId: f.id(),
  body: f.str()
});
const FetchSchema = defineShape<FetchRow>()({ value: f.str() });

type ValueRelation = {
  read(): FetchRow | undefined;
  fetch(): Promise<void>;
  refresh(): Promise<void>;
};

type ListRelation = {
  read(): FetchRow[];
  fetch(): Promise<void>;
  refresh(): Promise<void>;
};

const readValue = (relation: ValueRelation): string | undefined => relation.read()?.value;

const defineValueModel = (key: string, options: { staleTime?: number | string; emptyStaleTime?: number | string } = {}) =>
  defineModel(key, {
    schema: FetchSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.single(fetchDocument, {
          variables: (params: FetchVariables) => params,
          select: data => ({ id: 'fetch-result', value: data.value }),
          ...options
        })
      }
    })
  });

const defineListModel = (key: string, options: { staleTime?: number | string; emptyStaleTime?: number | string } = {}) =>
  defineModel(key, {
    schema: FetchSchema,
    relations: owner => ({
      result: {
        remote: owner.gql.list(fetchDocument, {
          variables: (params: FetchVariables) => params,
          select: () => [],
          ...options
        })
      }
    })
  });

const configure = (storage: ReturnType<typeof createMemoryPlane>, transport = createMockTransport()): void => {
  configureDb({
    storage,
    transport,
    dataVersion: 'durable-freshness',
    defaults: { staleTime: 1_000, emptyStaleTime: 5_000 }
  });
};

const rewriteQueryRecord = (
  storage: ReturnType<typeof createMemoryPlane>,
  update: (record: QueryPersistenceRecord) => QueryPersistenceRecord
): void => {
  const key = storage.snapshotKeys().find(candidate => candidate.startsWith('dbl:query:'));
  if (key === undefined) throw new Error('query record is missing');
  const envelope = JSON.parse(storage.get(key)!) as { payload: QueryPersistenceRecord };
  [{ key, value: encodePersistence(update(envelope.payload)) }].forEach(entry => storage.set(entry.key, entry.value));
};

const readOnlyQueryRecord = (storage: ReturnType<typeof createMemoryPlane>): QueryPersistenceRecord<{ ids: string[] }> => {
  const key = storage.snapshotKeys().find(candidate => candidate.startsWith('dbl:query:'));
  if (key === undefined) throw new Error('query record is missing');
  const envelope = JSON.parse(storage.get(key)!) as { payload: QueryPersistenceRecord<{ ids: string[] }> };
  return envelope.payload;
};

describe('durable freshness', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('[F9] restores a fresh named fetch with its original timestamp and without transport', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { value: `scope-${++calls}` } as TData })
    });
    configure(storage, transport);
    const model = defineValueModel('DurableFetchFresh', { staleTime: 1_000 });
    const request = model.result({ scope: 'scope' }) as ValueRelation;

    await request.fetch();
    expect(readValue(request)).toBe('scope-1');
    jest.advanceTimersByTime(999);
    configure(storage, transport);

    expect(readValue(request)).toBe('scope-1');
    await request.fetch();
    expect(readValue(request)).toBe('scope-1');
    expect(calls).toBe(1);
  });

  it('[F10] refetches an expired named fetch exactly once after restart', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { value: `scope-${++calls}` } as TData })
    });
    configure(storage, transport);
    const model = defineValueModel('DurableFetchExpired', { staleTime: 1_000 });
    const request = model.result({ scope: 'scope' }) as ValueRelation;

    await request.fetch();
    jest.advanceTimersByTime(1_001);
    configure(storage, transport);

    await Promise.all([request.fetch(), request.fetch()]);
    expect(readValue(request)).toBe('scope-2');
    expect(calls).toBe(2);
  });

  it('uses emptyStaleTime for a restored empty selected value', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { value: String(++calls) } as TData })
    });
    configure(storage, transport);
    const model = defineListModel('DurableFetchEmpty', { staleTime: 1_000, emptyStaleTime: 5_000 });
    const request = model.result({}) as ListRelation;

    await request.fetch();
    jest.advanceTimersByTime(4_999);
    configure(storage, transport);

    await request.fetch();
    expect(request.read()).toEqual([]);
    expect(calls).toBe(1);
  });

  it('[P17] keeps runtime-zero and anonymous fetches process-local', async () => {
    const storage = createMemoryPlane();
    let zeroCalls = 0;
    let anonymousCalls = 0;
    const zeroTransport = createMockTransport({
      query: async <TData,>() => ({ data: { value: String(++zeroCalls) } as TData })
    });
    configure(storage, zeroTransport);
    const zeroModel = defineValueModel('DurableFetchZero', { staleTime: 0 });
    const zero = zeroModel.result({}) as ValueRelation;

    await zero.fetch();
    configure(storage, zeroTransport);
    await zero.fetch();

    const anonymousTransport = createMockTransport({
      query: async <TData,>() => ({ data: { value: String(++anonymousCalls) } as TData })
    });
    configure(storage, anonymousTransport);
    const anonymousModel = defineValueModel('DurableFetchAnonymous', { staleTime: 0 });
    const anonymous = anonymousModel.result({}) as ValueRelation;

    await anonymous.fetch();
    configure(storage, anonymousTransport);
    await anonymous.fetch();

    expect({ zeroCalls, anonymousCalls }).toEqual({ zeroCalls: 2, anonymousCalls: 2 });
  });

  it('rejects a persisted input mismatch and a now-process-local freshness policy', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { value: String(++calls) } as TData })
    });
    configure(storage, transport);
    const first = defineValueModel('DurableFetchPolicyChange', { staleTime: 1_000 });
    const firstResult = first.result({ scope: 'scope' }) as ValueRelation;
    await firstResult.fetch();
    rewriteQueryRecord(storage, record => ({ ...record, scope: 'other-scope' }));

    configure(storage, transport);
    expect(readValue(firstResult)).toBeUndefined();
    await firstResult.fetch();
    configure(storage, transport);
    const processLocal = defineValueModel('DurableFetchPolicyChange', { staleTime: 0 });
    const processLocalResult = processLocal.result({ scope: 'scope' }) as ValueRelation;

    expect(readValue(processLocalResult)).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('[P16] restores invalidated data as stale', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { value: String(++calls) } as TData })
    });
    configureDb({
      storage,
      transport,
      defaults: { staleTime: 1_000 }
    });
    const first = defineValueModel('DurableFetchInvalidated', { staleTime: 1_000 });
    const firstResult = first.result({}) as ValueRelation;
    await bootDb();
    await firstResult.fetch();
    rewriteQueryRecord(storage, record => ({ ...record, invalidated: true }));

    configureDb({
      storage,
      transport,
      defaults: { staleTime: 1_000 }
    });
    const restored = defineValueModel('DurableFetchInvalidated', { staleTime: 1_000 });
    await bootDb();
    const restoredResult = restored.result({}) as ValueRelation;
    expect(readValue(restoredResult)).toBe('1');
    await restoredResult.fetch();
    expect(readValue(restoredResult)).toBe('2');
  });

  it('[F13] separates freshness-aware fetch, forced refresh, and family removal', async () => {
    const storage = createMemoryPlane();
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { value: String(++calls) } as TData })
    });
    configure(storage, transport);
    const model = defineValueModel('DurableFetchControls', { staleTime: 1_000 });
    const request = model.result({}) as ValueRelation;

    await request.fetch();
    expect(readValue(request)).toBe('1');
    await request.fetch();
    expect(readValue(request)).toBe('1');
    await request.refresh();
    expect(readValue(request)).toBe('2');
    getDbQueryClient().removeQueries();
    configure(storage, transport);
    await bootDb();

    expect(readValue(request)).toBeUndefined();
    await request.refresh();
    expect(readValue(request)).toBe('3');
  });

  it('[P13] restores model relation rows and pagination metadata before freshness evaluation', async () => {
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
      relations: owner => ({
        thread: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: owner.gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 1_000
          })
        }
      })
    });
    await bootDb();
    await Message.thread({ chatId: 'chat-1' }).fetch();
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
      relations: owner => ({
        thread: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: owner.gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 10_000
          })
        },
        sibling: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: owner.gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 10_000
          })
        }
      })
    });
    await bootDb();
    await Message.thread({ chatId: 'chat-1' }).fetch();
    await Message.thread({ chatId: 'chat-2' }).fetch();
    await Message.sibling({ chatId: 'chat-3' }).fetch();

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
      relations: owner => ({
        thread: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: owner.gql.connection(threadDocument, {
            variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
            connection: data => data.messages,
            staleTime: 1_000
          })
        }
      })
    });
    await bootDb();
    const relation = Message.thread({ chatId: 'chat-1' });
    await relation.fetch();

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

    const scopePrefix = compositeStorageKey('dbl:', 'scope', 'DurableFreshnessDestinationValidation');
    getApplyRuntime().flushCacheSnapshots();
    storage.keys(scopePrefix).map(key => ({ key, value: null })).forEach(entry => storage.set(entry.key, entry.value));
    configure(storage, transport);
    await bootDb();
    await relation.fetch();
    expect(calls).toBe(3);

    relation.seed([
      ...relation.read(),
      { id: 'keep-row', chatId: 'chat-1', body: 'keep' }
    ]);
    getApplyRuntime().flushCacheSnapshots();
    storage.set(compositeStorageKey('dbl:', 'row', 'DurableFreshnessDestinationValidation', 'm-3'), null);
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

    rewriteQueryRecord(storage, record => ({ ...record, scope: { chatId: null } }));
    configure(storage, transport);
    await bootDb();
    expect(() => Message.thread({ chatId: 'other-chat' }).invalidate()).not.toThrow();
  });

  it('reconciles a missing direct-model destination row and rejects a disabled durable policy', async () => {
    const storage = createMemoryPlane();
    const onSyncError = jest.fn();
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
        onSyncError
      }
    });
    const Message = defineModel('DurableFreshnessDirectDestination', {
      schema: MessageSchema,
      relations: owner => ({
        details: {
          remote: owner.gql.single(detailDocument, {
            variables: ({ id }: { id: string }) => ({ id }),
            select: data => data.message,
            staleTime: 'durable'
          })
        }
      })
    });
    await bootDb();
    const details = Message.details({ id: 'm-1' });
    await details.fetch();
    const originalStamp = readOnlyQueryRecord(storage).dataUpdatedAt;

    const rowPrefix = compositeStorageKey('dbl:', 'row', 'DurableFreshnessDirectDestination');
    getApplyRuntime().flushCacheSnapshots();
    storage.keys(rowPrefix).map(key => ({ key, value: null })).forEach(entry => storage.set(entry.key, entry.value));
    configureDb({
      storage,
      transport,
      dataVersion: 'durable-freshness',
      defaults: {
        freshnessClasses: { durable: 1_000 },
        onSyncError
      }
    });
    const MessageAfterRestart = defineModel('DurableFreshnessDirectDestination', {
      schema: MessageSchema,
      relations: owner => ({
        details: {
          remote: owner.gql.single(detailDocument, {
            variables: ({ id }: { id: string }) => ({ id }),
            select: data => data.message,
            staleTime: 'durable'
          })
        }
      })
    });
    await bootDb();
    const restartedDetails = MessageAfterRestart.details({ id: 'm-1' });

    expect(restartedDetails.read()).toBeUndefined();
    expect(readOnlyQueryRecord(storage)).toMatchObject({ payload: { ids: [] }, empty: true, dataUpdatedAt: originalStamp, invalidated: true });
    expect(onSyncError).not.toHaveBeenCalled();
    await restartedDetails.fetch();
    expect(calls).toBe(2);
  });

  it('[P19] drops restored query metadata when its named freshness class becomes process-local', async () => {
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
        freshnessClasses
      }
    });
    const Message = defineModel('DurableFreshnessProcessLocalPolicy', {
      schema: MessageSchema,
      relations: owner => ({
        details: {
          remote: owner.gql.single(detailDocument, {
            variables: ({ id }: { id: string }) => ({ id }),
            select: data => data.message,
            staleTime: 'durable'
          })
        }
      })
    });
    await bootDb();
    const processLocalDetails = Message.details({ id: 'm-1' });
    await processLocalDetails.fetch();
    getDbQueryClient().removeQueries();
    expect(storage.keys('dbl:query:').length).toBeGreaterThan(0);
    freshnessClasses.durable = 0;

    processLocalDetails.read();
    // The refetch below happens either way - zero freshness makes even a restored chain stale. What
    // the drop decides is whether the record stays on disk to be restored again next launch.
    expect(storage.keys('dbl:query:')).toEqual([]);
    await processLocalDetails.fetch();
    expect(calls).toBe(2);
  });
});
