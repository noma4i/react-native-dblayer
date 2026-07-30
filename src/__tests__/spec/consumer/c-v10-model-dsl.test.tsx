import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { act } from 'react';
import { configureDb, defineModel, defineShape, f, gql } from '../../../index';
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

const threadDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ThreadData, ThreadVariables>;
const sendDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<SendData, SendVariables>;
const messageDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<MessageData, MessageVariables>;
const messageCreatedDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<MessageCreatedData, never>;

const MessageSchema = defineShape<MessageInput>()({
  chatId: f.id(),
  body: f.str(),
  status: f.enum(['sending', 'sent'] as const)
});

const createMessageModel = (suffix: string) =>
  defineModel(`SpecV10Message${suffix}`, {
    schema: MessageSchema,
    relations: {
      thread: {
        by: { chatId: 'chatId' },
        sort: 'server-order',
        remote: gql.connection(threadDocument, {
          variables: (params: { chatId: string }) => ({ chatId: params.chatId }),
          connection: data => data.messages
        })
      },
      details: {
        remote: gql.single(messageDocument, {
          variables: (params: { id: string }) => ({ id: params.id }),
          select: data => data.message,
          required: ['id']
        })
      }
    },
    actions: {
      send: gql.action(sendDocument, {
        result: 'send',
        variables: input => ({ input }),
        kind: 'insert',
        select: data => data.send.message,
        optimistic: {
          build: (input, context) => ({
            id: context.tempId,
            chatId: input.chatId,
            body: input.body,
            status: 'sending'
          })
        }
      })
    },
    events: {
      messageCreated: gql.live(messageCreatedDocument, {
        handler: payload => ({ upsert: payload.message })
      })
    },
    maintenance: { dropTempRowsAfterMs: 1000 }
  });

describe('v10 model surface', () => {
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
    expect(reader.result().hasMore).toBe(false);
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

  it('owns typed subscription landing through its event handle', () => {
    configureRuntime(createMockTransport());
    const Message = createMessageModel('Event');

    Message.events.apply('messageCreated', {
      message: { id: 'm-live', chatId: 'chat-1', body: 'delivered', status: 'sent' }
    });

    expect(Message.find('m-live')).toEqual({
      id: 'm-live',
      chatId: 'chat-1',
      body: 'delivered',
      status: 'sent'
    });
    expect(Message.events.entries).toHaveLength(1);
    expect(Message.events.entries[0]?.key).toBe('messageCreated');
  });
});

const configureRuntime = (transport: ReturnType<typeof createMockTransport>): void => {
  configureDb({ storage: createMemoryPlane(), transport });
};
