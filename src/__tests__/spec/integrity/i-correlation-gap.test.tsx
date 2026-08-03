import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { Kind, OperationTypeNode } from 'graphql';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { configureDb, defineModel, defineShape, f, resetRuntime, useDbSubscriptions, type DbTransport } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Message = { id: string; chatId: string; body: string; status: 'sending' | 'sent' };
type SendInput = { chatId: string; body: string };
type SendData = { messageSend: { message: Message } };
type SendVariables = { input: SendInput };
type QueryData = { messages: Message[] };
type QueryVariables = { chatId: string };
type EventData = { messageCreated: { message: Message } };
type Gift = { id: string; label: string };
type GiftData = { giftSend: { gift: Gift; message: Message } };
type GiftVariables = { input: { label: string } };

const MessageSchema = defineShape<Message>()({
  chatId: f.str(),
  body: f.str(),
  status: f.enum(['sending', 'sent'] as const)
});
const GiftSchema = defineShape<Gift>()({ label: f.str() });
const sendDocument: TypedDocumentNode<SendData, SendVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const queryDocument: TypedDocumentNode<QueryData, QueryVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const giftDocument: TypedDocumentNode<GiftData, GiftVariables> = { kind: Kind.DOCUMENT, definitions: [] };
const eventDocument: TypedDocumentNode<EventData, Record<string, never>> = {
  kind: Kind.DOCUMENT,
  definitions: [
    {
      kind: Kind.OPERATION_DEFINITION,
      operation: OperationTypeNode.SUBSCRIPTION,
      variableDefinitions: [],
      directives: [],
      selectionSet: {
        kind: Kind.SELECTION_SET,
        selections: [{ kind: Kind.FIELD, name: { kind: Kind.NAME, value: 'messageCreated' }, arguments: [], directives: [] }]
      }
    }
  ]
};

const defineMessages = (key: string) =>
  defineModel(key, {
    schema: MessageSchema,
    maintenance: { dropTempRowsAfterMs: 60_000 },
    relations: owner => ({
      thread: {
        by: { chatId: 'chatId' },
        remote: owner.gql.list(queryDocument, {
          variables: (params: QueryVariables) => params,
          select: data => data.messages
        })
      }
    }),
    actions: owner => ({
      send: owner.gql.action(sendDocument, {
        mode: 'request',
        result: 'messageSend',
        variables: (input: SendInput) => ({ input }),
        optimistic: {
          root: {
            insert: {
              select: ({ input, tempId }) => ({ id: tempId, ...input, status: 'sending' as const })
            }
          },
          correlate: { fields: ['chatId', 'body'] }
        },
        root: { insert: { select: ({ data }) => data.messageSend.message } }
      }),
      sendDurable: owner.gql.action(sendDocument, {
        mode: 'durable',
        result: 'messageSend',
        variables: (input: SendInput, _transportInput: Record<string, never>) => ({ input }),
        optimistic: {
          root: {
            insert: {
              select: ({ input, tempId }) => ({ id: tempId, ...input, status: 'sending' as const })
            }
          },
          correlate: { fields: ['chatId', 'body'] }
        },
        root: { insert: { select: ({ data }) => data.messageSend.message } }
      })
    }),
    events: owner => ({
      created: owner.gql.live(eventDocument, {
        variables: {},
        root: { insert: { select: ({ payload }) => payload.message } }
      })
    })
  });

const startPendingSend = (messages: ReturnType<typeof defineMessages>): string => {
  act(() => {
    void messages.actions.send.run({ chatId: 'chat-1', body: 'hello' });
  });
  const rows = messages.thread({ chatId: 'chat-1' }).read();
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
};

const expectCorrelated = (messages: ReturnType<typeof defineMessages>, tempId: string): void => {
  expect(messages.thread({ chatId: 'chat-1' }).read()).toEqual([{ id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'sent' }]);
  expect(messages.find(tempId)).toBeUndefined();
  expect(messages.operation(tempId).read().pending).toBe(false);
};

function Activation(): null {
  useDbSubscriptions(true);
  return null;
}

afterEach(resetRuntime);

describe('channel-agnostic temp correlation', () => {
  it('collapses an open temp row when a query lands the server row', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: () => new Promise(() => undefined),
        query: async <TData,>() => ({
          data: { messages: [{ id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'sent' }] } as TData
        })
      })
    });
    const messages = defineMessages('SpecCorrelationQuery');
    const tempId = startPendingSend(messages);

    await act(async () => messages.thread({ chatId: 'chat-1' }).fetch());

    expectCorrelated(messages, tempId);
  });

  it('collapses an open temp row when a model event lands the server row', () => {
    let next!: (data: unknown) => void;
    const transport = createMockTransport({
      mutation: () => new Promise(() => undefined),
      subscribe: (_options: Parameters<NonNullable<DbTransport['subscribe']>>[0], handlers: Parameters<NonNullable<DbTransport['subscribe']>>[1]) => {
        next = handlers.next;
        return () => undefined;
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = defineMessages('SpecCorrelationEvent');
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(React.createElement(Activation));
    });
    const tempId = startPendingSend(messages);

    act(() => next({ messageCreated: { message: { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'sent' } } }));

    expectCorrelated(messages, tempId);
    const durable = messages.actions.sendDurable.start({ chatId: 'chat-1', body: 'durable' });
    act(() => next({ messageCreated: { message: { id: 'server-2', chatId: 'chat-1', body: 'durable', status: 'sent' } } }));
    act(() => root.unmount());
    expect(messages.thread({ chatId: 'chat-1' }).read()).toEqual([
      { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'sent' },
      { id: 'server-2', chatId: 'chat-1', body: 'durable', status: 'sent' }
    ]);
    expect(messages.find(durable.tempId)).toBeUndefined();
    expect(messages.operation(durable.tempId).read().pending).toBe(false);
  });

  it('collapses an open temp row when another model action plans the server row', async () => {
    const transport = createMockTransport({
      mutation: async <TData,>(operation: Parameters<DbTransport['mutation']>[0]) => {
        if (operation.mutation === sendDocument) return await new Promise<{ data: TData }>(() => undefined);
        return {
          data: {
            giftSend: {
              gift: { id: 'gift-1', label: 'gift' },
              message: { id: 'server-1', chatId: 'chat-1', body: 'hello', status: 'sent' }
            }
          } as TData
        };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const messages = defineMessages('SpecCorrelationWritePlan');
    const gifts = defineModel('SpecCorrelationGifts', {
      schema: GiftSchema,
      actions: owner => ({
        send: owner.gql.action(giftDocument, {
          mode: 'request',
          result: 'giftSend',
          variables: (input: GiftVariables['input']) => ({ input }),
          root: { insert: { select: ({ data }) => data.giftSend.gift } },
          write: ({ data }, plan) => plan.upsert(messages, data.giftSend.message)
        })
      })
    });
    const tempId = startPendingSend(messages);

    await act(async () => gifts.actions.send.run({ label: 'gift' }));

    expectCorrelated(messages, tempId);
  });
});
