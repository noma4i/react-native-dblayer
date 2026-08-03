import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { act } from 'react';
import { configureDb, createSingletonStatics, defineModel, defineShape, f, type ModelInput, type ModelStored } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, renderCountedInProvider, settleUntil } from '../helpers/harness';

type MessageInput = {
  id: string;
  chatId: string;
  body: string;
  status: 'sending' | 'sent';
};

type ThreadData = {
  messages: {
    nodes: MessageInput[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type ThreadVariables = {
  chatId: string;
  after?: string | null;
};

type SendData = {
  send: {
    message: MessageInput;
  };
};

type SendVariables = {
  input: {
    chatId: string;
    body: string;
  };
};

type MessageData = {
  message: MessageInput | null;
};

type MessageVariables = {
  id: string;
};

type MessageCreatedData = {
  messageCreated: {
    message: MessageInput;
  };
};

type CatalogData = {
  catalog: Array<MessageInput | null>;
};

type EdgeThreadData = {
  messages: {
    edges: Array<{ node?: MessageInput | null } | null> | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const threadDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ThreadData, ThreadVariables>;
const sendDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<SendData, SendVariables>;
const messageDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<MessageData, MessageVariables>;
const messageCreatedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'subscription',
      selectionSet: {
        kind: 'SelectionSet',
        selections: [{ kind: 'Field', name: { kind: 'Name', value: 'messageCreated' } }]
      }
    }
  ]
} as unknown as TypedDocumentNode<MessageCreatedData, Record<string, never>>;
const catalogDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<CatalogData, Record<string, never>>;
const edgeThreadDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<EdgeThreadData, ThreadVariables>;

const MessageSchema = defineShape<MessageInput>()({
  chatId: f.id(),
  body: f.str(),
  status: f.enum(['sending', 'sent'] as const)
});

const createMessageModel = (suffix: string) =>
  defineModel(`SpecMessage${suffix}`, {
    schema: MessageSchema,
    relations: owner => ({
      thread: {
        by: { chatId: 'chatId' as const },
        sort: 'server-order',
        remote: owner.gql.connection(threadDocument, {
          variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
          connection: data => data.messages
        })
      },
      details: {
        remote: owner.gql.single(messageDocument, {
          variables: (params: { id: string }) => ({ id: params.id }),
          select: data => data.message,
          required: ['id']
        })
      }
    }),
    actions: owner => ({
      send: owner.gql.action(sendDocument, {
        mode: 'request',
        result: 'send',
        variables: input => ({ input }),
        root: { insert: { select: ({ data }) => data.send.message } },
        optimistic: {
          root: { insert: { select: ({ input, tempId }) => ({
            id: tempId,
            chatId: input.chatId,
            body: input.body,
            status: 'sending'
          }) } }
        }
      })
    }),
    events: owner => ({
      messageCreated: owner.gql.live(messageCreatedDocument, {
        variables: {},
        root: { insert: { select: ({ payload }) => payload.message } }
      })
    }),
    maintenance: { dropTempRowsAfterMs: 1000 }
  });

type MessageModelType = ReturnType<typeof createMessageModel>;
const assertModelUtilityTypes = (stored: ModelStored<MessageModelType>, input: ModelInput<MessageModelType>): void => {
  const storedStatus: MessageInput['status'] = stored.status;
  const inputStatus: MessageInput['status'] = input.status;
  void storedStatus;
  void inputStatus;
};
void assertModelUtilityTypes;

describe('model surface', () => {
  it('normalizes transport row ids through the model id codec', () => {
    configureRuntime(createMockTransport());
    const Imported = defineModel('SpecTransportRowId', {
      schema: defineShape<{ sourceId: string | number; title: string }>()({
        title: f.str()
      }),
      rowId: input => input.sourceId
    });

    Imported.insert({ sourceId: 42, title: 'numeric transport id' });

    expect(Imported.find('42')).toEqual({ id: '42', title: 'numeric transport id' });
  });

  it('builds singleton statics from the public model facade', () => {
    configureRuntime(createMockTransport());
    const Counters = defineModel('SpecSingletonCounters', {
      schema: defineShape<{ id: string; unread: number }>()({
        unread: f.int()
      }),
      statics: model => createSingletonStatics(model, 'counters', { id: 'counters', unread: 0 })
    });
    const reader = renderCounted(() => Counters.useCurrentField('unread'));

    expect(reader.result()).toBe(0);
    act(() => Counters.upsertCurrent({ unread: 2 }));
    expect(reader.result()).toBe(2);
    reader.unmount();
  });

  it('uses the same Relation contract for local named, where, and id-list reads', async () => {
    configureRuntime(createMockTransport());
    const Message = createMessageModel('LocalMatrix');
    const built = Message.build({ id: 'built', chatId: 'chat-1', body: 'built', status: 'sent' });
    expect(built).toEqual({ id: 'built', chatId: 'chat-1', body: 'built', status: 'sent' });
    expect(Message.find('built')).toBeUndefined();

    Message.insertMany([
      { id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' },
      { id: 'm2', chatId: 'chat-1', body: 'second', status: 'sent' },
      { id: 'm3', chatId: 'chat-2', body: 'third', status: 'sent' }
    ]);

    const thread = Message.thread({ chatId: 'chat-1' });
    const inactiveThread = Message.thread(null);
    expect(inactiveThread.read()).toEqual([]);
    expect(inactiveThread.count()).toBe(0);
    inactiveThread.invalidate();
    expect(() => inactiveThread.issueSequence('body')).toThrow('requires an active relation');
    expect(thread.count()).toBe(2);
    expect(Message.where({ chatId: 'chat-1' }).count()).toBe(2);
    expect(Message.byIds(['missing', 'm1']).read().map(row => row.id)).toEqual(['m1']);
    expect(thread.issueSequence('body')).toEqual(expect.any(Number));
    expect(() => Message.where({ chatId: 'chat-1' }).issueSequence('body')).toThrow('requires a named relation');
    expect(() => Message.byIds(['m1']).issueSequence('body')).toThrow('requires a named relation');

    const whereReader = renderCounted(() =>
      Message.where({ chatId: 'chat-1' }, { orderBy: { field: 'body', direction: 'desc' }, limit: 1 }).use()
    );
    const whereCount = renderCounted(() => Message.where({ chatId: 'chat-1' }).useCount());
    const byIdsReader = renderCounted(() => Message.byIds(['missing', 'm2', 'm1']).use());
    const byIdsCount = renderCounted(() => Message.byIds(['missing', 'm2', 'm1']).useCount());
    const threadCount = renderCounted(() => thread.useCount());
    try {
      expect(whereReader.result().data.map(row => row.id)).toEqual(['m2']);
      whereReader.result().loadMore();
      expect(whereCount.result()).toBe(2);
      expect(Message.byIds(undefined).read()).toEqual([]);
      expect(Message.byIds(undefined).count()).toBe(0);
      expect(byIdsReader.result().data.map(row => row.id)).toEqual(['m2', 'm1']);
      byIdsReader.result().loadMore();
      expect(Message.byIds(['missing', 'm2', 'm1']).count()).toBe(2);
      expect(byIdsCount.result()).toBe(2);
      expect(threadCount.result()).toBe(2);

      Message.where({ chatId: 'chat-1' }).invalidate();
      Message.byIds(['m1', 'm2']).invalidate();
      thread.invalidate();
      await expect(Message.where({ chatId: 'chat-3' }).fetch()).resolves.toBeUndefined();
      await expect(Message.where({ chatId: 'chat-3' }).refresh()).resolves.toBeUndefined();
      await expect(Message.byIds([]).fetch()).resolves.toBeUndefined();
      await expect(Message.byIds([]).refresh()).resolves.toBeUndefined();
      Message.where({ chatId: 'chat-3' }).seed([{ id: 'm4', chatId: 'chat-3', body: 'fourth', status: 'sent' }]);
      Message.byIds([]).seed([{ id: 'm5', chatId: 'chat-4', body: 'fifth', status: 'sent' }]);
    } finally {
      whereReader.unmount();
      whereCount.unmount();
      byIdsReader.unmount();
      byIdsCount.unmount();
      threadCount.unmount();
    }
  });

  it('uses one complete Relation result for a local-only named relation', async () => {
    configureRuntime(createMockTransport());
    const Message = defineModel('SpecLocalOnlyMessage', {
      schema: MessageSchema,
      relations: _owner => ({
        thread: {
          by: { chatId: 'chatId' },
          sort: { field: 'body', dir: 'asc' }
        }
      })
    });
    Message.insertMany([
      { id: 'm2', chatId: 'chat-1', body: 'second', status: 'sent' },
      { id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' }
    ]);
    const relation = Message.thread({ chatId: 'chat-1' });
    relation.seed([
      { id: 'm3', chatId: 'chat-1', body: 'third', status: 'sent' },
      { id: 'm4', chatId: 'chat-1', body: 'fourth', status: 'sent' }
    ]);
    const reader = renderCounted(() => relation.use({ pageSize: 1, keepPrevious: true }));
    const defaultReader = renderCounted(() => relation.use());
    const countReader = renderCounted(() => relation.useCount());
    expect(reader.result().data.map(row => row.id)).toEqual(['m4']);
    expect(defaultReader.result().data.map(row => row.id)).toEqual(['m4', 'm3']);
    expect(reader.result().loadingState.isReady).toBe(true);
    expect(reader.result().isFetchingMore).toBe(false);
    expect(reader.result().isPreviousData).toBe(false);
    expect(reader.result().hasMore).toBe(true);
    expect(relation.count()).toBe(2);
    expect(countReader.result()).toBe(2);
    relation.invalidate();
    expect(relation.issueSequence('body')).toEqual(expect.any(Number));
    act(() => reader.result().loadMore());
    expect(reader.result().data.map(row => row.id)).toEqual(['m4', 'm3']);
    await expect(relation.fetch()).resolves.toBeUndefined();
    await expect(reader.result().refresh()).resolves.toBeUndefined();
    countReader.unmount();
    defaultReader.unmount();
    reader.unmount();
  });

  it('lands a complete remote list without a pagination bridge', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          catalog: [
            { id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' },
            null,
            { id: 'm2', chatId: 'chat-1', body: 'second', status: 'sent' }
          ]
        } as TData
      })
    });
    configureRuntime(transport);
    const Message = defineModel('SpecMessageCatalog', {
      schema: MessageSchema,
      relations: owner => ({
        catalog: {
          sort: 'server-order',
          remote: owner.gql.list(catalogDocument, {
            variables: () => ({}),
            select: data => data.catalog,
            map: node => ({ ...node, body: node.body.toUpperCase() })
          })
        }
      })
    });
    const relation = Message.catalog({});

    await relation.fetch();

    expect(relation.read().map(row => row.body)).toEqual(['FIRST', 'SECOND']);
  });

  it('keeps a null remote list empty', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: { catalog: [{ id: 'plain-1', chatId: 'chat-1', body: 'plain', status: 'sent' }] } as TData
      })
    });
    configureRuntime(transport);
    const Message = defineModel('SpecNullMessageCatalog', {
      schema: MessageSchema,
      relations: owner => ({
        catalog: {
          remote: owner.gql.list(catalogDocument, {
            variables: () => ({}),
            select: () => null
          })
        },
        plain: {
          remote: owner.gql.list(catalogDocument, {
            variables: () => ({}),
            select: data => data.catalog
          })
        }
      })
    });

    await Message.catalog({}).fetch();
    await Message.plain({}).fetch();

    expect(Message.catalog({}).read()).toEqual([]);
    expect(Message.plain({}).read().map(row => row.id)).toEqual(['plain-1']);
  });

  it('lands mapped connection edges and advances with a declared cursor', async () => {
    let page = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        page += 1;
        return {
          data: {
            messages:
              page === 1
                ? {
                    edges: [
                      null,
                      { node: null },
                      { node: { id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' } }
                    ],
                    pageInfo: { hasNextPage: true, endCursor: 'edge-1' }
                  }
                : {
                    edges: [{ node: { id: 'm2', chatId: 'chat-1', body: 'second', status: 'sent' } }],
                    pageInfo: { hasNextPage: false, endCursor: null }
                  }
          } as TData
        };
      }
    });
    configureRuntime(transport);
    const Message = defineModel('SpecEdgeConnectionMessage', {
      schema: MessageSchema,
      relations: owner => ({
        thread: {
          by: { chatId: 'chatId' },
          sort: 'server-order',
          remote: owner.gql.connection(edgeThreadDocument, {
            variables: (params: { chatId: string; after?: string | null }) => params,
            connection: data => data.messages,
            map: node => ({ ...node, body: node.body.toUpperCase() }),
            cursor: (_data, connection) => connection.pageInfo.endCursor
          })
        }
      })
    });
    const reader = renderCountedInProvider(() => Message.thread({ chatId: 'chat-1' }).use({ loadMoreDebounceMs: 0 }));

    await settleUntil(() => reader.result() !== undefined && reader.result().loadingState.isReady);
    expect(reader.result().data.map(row => row.body)).toEqual(['FIRST']);
    act(() => reader.result().loadMore());
    await settleUntil(() => reader.result().data.length === 2, 50, { macro: true });
    expect(reader.result().data.map(row => row.body)).toEqual(['FIRST', 'SECOND']);
    reader.unmount();

    const EmptyMessage = defineModel('SpecEmptyEdgeConnectionMessage', {
      schema: MessageSchema,
      relations: owner => ({
        thread: {
          remote: owner.gql.connection(edgeThreadDocument, {
            variables: (params: { chatId: string }) => params,
            connection: () => ({
              edges: null,
              pageInfo: { hasNextPage: false, endCursor: null }
            })
          })
        }
      })
    });
    await EmptyMessage.thread({ chatId: 'chat-1' }).fetch();
    expect(EmptyMessage.thread({ chatId: 'chat-1' }).read()).toEqual([]);
  });

  it('exposes one immutable relation for snapshot and reactive local reads', () => {
    configureRuntime(createMockTransport());
    const Message = createMessageModel('Local');
    Message.insert({ id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' });
    Message.insert({ id: 'm2', chatId: 'chat-2', body: 'other', status: 'sent' });

    const thread = Message.thread({ chatId: 'chat-1' });
    expect(thread.read()).toEqual([{ id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' }]);

    const reader = renderCounted(() => thread.use());
    expect(reader.result().data.map(row => row.id)).toEqual(['m1']);
    expect(reader.result().hasMore).toBe(false);

    act(() => {
      Message.insert({ id: 'm3', chatId: 'chat-1', body: 'second', status: 'sent' });
    });
    expect(reader.result().data.map(row => row.id)).toEqual(['m1', 'm3']);
    reader.unmount();
  });

  it('combines remote loading, local windowing, pagination, and refresh in the same relation result', async () => {
    let page = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        page += 1;
        const data: ThreadData =
          page === 1
            ? {
                messages: {
                  nodes: [{ id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' }],
                  pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
                }
              }
            : {
                messages: {
                  nodes: [{ id: 'm2', chatId: 'chat-1', body: 'second', status: 'sent' }],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              };
        return { data: data as TData };
      }
    });
    configureRuntime(transport);
    const Message = createMessageModel('Remote');
    const reader = renderCountedInProvider(() => Message.thread({ chatId: 'chat-1' }).use({ pageSize: 1, loadMoreDebounceMs: 0 }));

    await settleUntil(() => reader.result() !== undefined && reader.result().loadingState.isReady);
    expect(reader.result().data.map(row => row.id)).toEqual(['m1']);
    expect(reader.result().hasMore).toBe(true);

    act(() => reader.result().loadMore());
    await settleUntil(() => reader.result().data.length === 2, 50, { macro: true });
    expect(reader.result().data.map(row => row.id)).toEqual(['m1', 'm2']);
    expect(reader.result().hasMore).toBe(false);
    await act(async () => {
      await reader.result().refresh();
    });
    reader.unmount();
  });

  it('lands and reads one remote row through the same relation surface', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          message: { id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' }
        } as TData
      })
    });
    configureRuntime(transport);
    const Message = createMessageModel('Single');
    const details = Message.details({ id: 'm1' });

    expect(details.read()).toBeUndefined();
    const reader = renderCountedInProvider(() => details.use());

    await settleUntil(() => reader.result() !== undefined && reader.result().loadingState.isReady);
    expect(reader.result().data).toEqual({ id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' });
    expect(details.read()).toEqual({ id: 'm1', chatId: 'chat-1', body: 'first', status: 'sent' });
    expect(details.count()).toBe(1);
    await details.fetch();
    await details.refresh();
    details.seed([{ id: 'm2', chatId: 'chat-2', body: 'seeded', status: 'sent' }]);
    expect(() => details.issueSequence('body')).toThrow('requires an ordered relation');
    expect(reader.result().hasMore).toBe(false);
    reader.result().loadMore();
    await act(async () => {
      await reader.result().refresh();
    });
    const countReader = renderCounted(() => details.useCount());
    expect(countReader.result()).toBe(1);
    details.invalidate();
    countReader.unmount();
    reader.unmount();
  });

  it('keeps an absent single relation empty across every read surface', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: { message: null } as TData })
    });
    configureRuntime(transport);
    const Message = createMessageModel('SingleMissing');
    const details = Message.details({ id: 'missing' });
    const reader = renderCountedInProvider(() => details.use());
    await settleUntil(() => reader.result() !== undefined && reader.result().loadingState.isReady);
    const countReader = renderCountedInProvider(() => details.useCount());
    await settleUntil(() => countReader.result() !== undefined);
    expect(details.read()).toBeUndefined();
    expect(details.count()).toBe(0);
    expect(countReader.result()).toBe(0);
    countReader.unmount();
    reader.unmount();
  });

  it('owns action persistence without repeating the optimistic model', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: {
          send: {
            message: { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'sent' }
          }
        } as TData
      })
    });
    configureRuntime(transport);
    const Message = createMessageModel('Action');
    const reader = renderCounted(() => Message.actions.send.use());

    await act(async () => {
      await reader.result().run({ chatId: 'chat-1', body: 'hello' });
    });

    expect(Message.find('server-1')).toEqual({
      id: 'server-1',
      chatId: 'chat-1',
      body: 'hello',
      status: 'sent'
    });
    expect(reader.result().isPending).toBe(false);
    expect(reader.result().error).toBeNull();
    reader.unmount();
  });

  it('reads owner rows from deferred action selectors', async () => {
    const observed: Array<{ found: string | undefined; count: number; selected: string[]; sequence: number }> = [];
    const transport = createMockTransport({
      mutation: async <TData,>() => ({
        data: {
          send: {
            message: { id: 'server-2', chatId: 'chat-1', body: 'reply', status: 'sent' }
          }
        } as TData
      })
    });
    configureRuntime(transport);
    const Message = defineModel('SpecOwnerReads', {
      schema: MessageSchema,
      relations: _owner => ({
        thread: {
          by: { chatId: 'chatId' as const },
          sort: { field: 'body', dir: 'asc' }
        }
      }),
      actions: owner => ({
        send: owner.gql.action(sendDocument, {
          mode: 'request',
          result: 'send',
          variables: input => ({ input }),
          root: { insert: { select: ({ data }) => data.send.message } },
          optimistic: {
            root: {
              insert: {
                select: ({ input, tempId }) => {
                  observed.push({
                    found: owner.find('seed')?.body,
                    count: owner.where({ chatId: input.chatId }).count(),
                    selected: owner.byIds(['missing', 'seed']).read().map(row => row.id),
                    sequence: owner.thread({ chatId: input.chatId }).issueSequence('body')
                  });
                  return { id: tempId, chatId: input.chatId, body: input.body, status: 'sending' };
                }
              }
            }
          }
        })
      }),
      maintenance: { dropTempRowsAfterMs: 1000 }
    });
    Message.insert({ id: 'seed', chatId: 'chat-1', body: 'first', status: 'sent' });

    await Message.actions.send.run({ chatId: 'chat-1', body: 'reply' });

    expect(observed).toEqual([{ found: 'first', count: 1, selected: ['seed'], sequence: expect.any(Number) }]);
  });

  it('rejects owner reads while declarations are being created', () => {
    configureRuntime(createMockTransport());

    expect(() =>
      defineModel('SpecImmediateOwnerRead', {
        schema: MessageSchema,
        actions: owner => {
          owner.find('missing');
          return {};
        }
      })
    ).toThrow('owner reads are only available inside deferred declaration callbacks');
  });

  it('exposes typed presentation subscription through its event handle', () => {
    configureRuntime(createMockTransport());
    const Message = createMessageModel('Event');
    const unsubscribe = Message.events.messageCreated.subscribe(payload => {
      expect(payload.message.id).toBe('m-live');
    });

    expect(typeof unsubscribe).toBe('function');
    expect('apply' in Message.events.messageCreated).toBe(false);
    unsubscribe();
  });
});

const configureRuntime = (transport: ReturnType<typeof createMockTransport>): void => {
  configureDb({ storage: createMemoryPlane(), transport });
};
