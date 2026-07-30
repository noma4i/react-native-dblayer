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

const threadDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<ThreadData, ThreadVariables>;
const sendDocument = { kind: 'Document', definitions: [] } as unknown as TypedDocumentNode<SendData, SendVariables>;

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
});

const configureRuntime = (transport: ReturnType<typeof createMockTransport>): void => {
  configureDb({ storage: createMemoryPlane(), transport });
};
