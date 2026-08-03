import { act } from 'react';
import {
  acquireModelSubscriptions,
  belongsTo,
  configureDb,
  defineModel,
  defineShape,
  f,
  type DbTransport
} from '../../testApi';
import { createMemoryPlane, createMockTransport, guardDataLoss, renderCounted } from '../helpers/harness';

const actionDocument = { kind: 'Document', definitions: [] } as never;
const liveDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'subscription',
      selectionSet: { kind: 'SelectionSet', selections: [{ kind: 'Field', name: { kind: 'Name', value: 'messageCreated' } }] }
    }
  ]
} as never;
const ownId = 'me';
const time = '2026-07-27T00:00:00Z';

type ChatRow = {
  id: string;
  unreadCount: number;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  lastSequenceNumber: number | null;
};

type MessageRow = {
  id: string;
  chatId: string;
  userId: string;
  body: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sequenceNumber: number | null;
  mediaBucket: string | null;
  media: Record<string, unknown> | null;
};

type SendData = { send: { message: MessageRow } };
type LiveData = { messageCreated: { message: MessageRow } };

const ChatSchema = defineShape<ChatRow>()({
  unreadCount: f.num(),
  lastMessageId: f.str().nullable(),
  lastMessageAt: f.str().nullable(),
  lastSequenceNumber: f.num().nullable()
});

const MessageSchema = defineShape<MessageRow>()({
  chatId: f.str(),
  userId: f.str(),
  body: f.str(),
  kind: f.str(),
  status: f.str(),
  createdAt: f.str(),
  updatedAt: f.str(),
  sequenceNumber: f.num().nullable(),
  mediaBucket: f.str().nullable(),
  media: f.raw<Record<string, unknown>>().nullable()
});

const compareMessagesNewest = (left: MessageRow, right: MessageRow): number => {
  if (left.sequenceNumber !== null && right.sequenceNumber !== null && left.sequenceNumber !== right.sequenceNumber) {
    return right.sequenceNumber - left.sequenceNumber;
  }
  return right.createdAt.localeCompare(left.createdAt);
};

const createModels = (suffix: string) => {
  const chats = defineModel(`AppMessageChat${suffix}`, { schema: ChatSchema });
  const messages = defineModel(`AppMessageMessage${suffix}`, {
    schema: MessageSchema,
    associations: () => ({
      chat: belongsTo<MessageRow, ChatRow>(chats, {
        foreignKey: 'chatId',
        touch: message => ({
          lastMessageId: message.id,
          lastMessageAt: message.createdAt,
          lastSequenceNumber: message.sequenceNumber
        }),
        counterCache: { field: 'unreadCount', filter: message => message.userId !== ownId }
      })
    }),
    relations: () => ({
      thread: { by: { chatId: 'chatId' }, sort: { comparator: compareMessagesNewest } },
      media: { by: { chatId: 'chatId', mediaBucket: 'mediaBucket' }, sort: { comparator: compareMessagesNewest } }
    }),
    maintenance: { dropTempRowsAfterMs: 60_000 },
    actions: owner => ({
      send: owner.gql.action<SendData, Record<string, never>, MessageRow, 'send'>(actionDocument, {
        mode: 'request',
        result: 'send',
        variables: () => ({}),
        optimistic: { root: { insert: { select: ({ input, tempId }) => ({ ...input, id: tempId }) } } },
        root: { insert: { select: ({ data }) => data.send.message } }
      })
    }),
    events: owner => ({
      created: owner.gql.live<LiveData, Record<string, never>>(liveDocument, {
        root: { insert: { select: ({ payload }) => payload.message } }
      })
    })
  });
  return { chats, messages };
};

const insertChat = (chats: ReturnType<typeof createModels>['chats']): void => {
  chats.insert({ id: 'chat-1', unreadCount: 0, lastMessageId: null, lastMessageAt: null, lastSequenceNumber: null });
};

const message = (id: string, overrides: Partial<MessageRow> = {}): MessageRow => ({
  id,
  chatId: 'chat-1',
  userId: ownId,
  body: 'hello',
  kind: 'text',
  status: 'Sending',
  createdAt: time,
  updatedAt: time,
  sequenceNumber: 1,
  mediaBucket: null,
  media: null,
  ...overrides
});

describe('app message send conformance', () => {
  guardDataLoss();

  it('C1 text success keeps one UI row while replacing the optimistic id with the server id', async () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        mutation: async <TData,>() => ({ data: { send: { message: message('server-1', { status: 'Sent' }) } } as TData })
      })
    });
    const { chats, messages } = createModels('Success');
    insertChat(chats);
    const reader = renderCounted(() => messages.thread({ chatId: 'chat-1' }).use().data);

    await act(async () => {
      await messages.actions.send.run(message('ignored'));
    });

    expect(messages.where({ chatId: 'chat-1' }).read()).toHaveLength(1);
    expect(messages.find('server-1')).toMatchObject({ id: 'server-1', body: 'hello', status: 'Sent' });
    expect(reader.result().map(row => row.id)).toEqual(['server-1']);
    reader.unmount();
  });

  it('C2 incoming other-user message updates the thread, preview, and unread counter atomically', () => {
    let eventHandlers!: Parameters<NonNullable<DbTransport['subscribe']>>[1];
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport({
        subscribe: (_options, handlers) => {
          eventHandlers = handlers;
          return () => undefined;
        }
      })
    });
    const { chats, messages } = createModels('Incoming');
    insertChat(chats);
    const release = acquireModelSubscriptions();

    act(() => {
      eventHandlers.next({
        messageCreated: {
          message: message('server-other', {
            userId: 'other',
            status: 'Sent',
            sequenceNumber: 2,
            createdAt: '2026-07-27T00:01:00Z',
            updatedAt: '2026-07-27T00:01:00Z'
          })
        }
      });
    });

    expect(messages.thread({ chatId: 'chat-1' }).read().map(row => row.id)).toEqual(['server-other']);
    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'server-other', unreadCount: 1 });
    release();
  });

  it('C3 media and thread relations share sequence-first order with a createdAt fallback', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const { chats, messages } = createModels('MediaOrder');
    insertChat(chats);
    messages.insert(
      message('confirmed', {
        kind: 'photo',
        status: 'Sent',
        sequenceNumber: 10,
        mediaBucket: 'visual',
        media: { id: 'media-confirmed', kind: 'photo', fileUrl: 'https://cdn/confirmed.jpg' }
      })
    );
    messages.insert(
      message('optimistic', {
        kind: 'photo',
        sequenceNumber: null,
        createdAt: '2026-07-27T00:01:00Z',
        mediaBucket: 'visual',
        media: { id: 'media-optimistic', kind: 'photo', fileUrl: 'file:///optimistic.jpg' }
      })
    );

    const expected = ['optimistic', 'confirmed'];
    expect(messages.thread({ chatId: 'chat-1' }).read().map(row => row.id)).toEqual(expected);
    expect(messages.media({ chatId: 'chat-1', mediaBucket: 'visual' }).read().map(row => row.id)).toEqual(expected);

    messages.update('optimistic', { sequenceNumber: 11 });

    expect(messages.thread({ chatId: 'chat-1' }).read().map(row => row.id)).toEqual(expected);
    expect(messages.media({ chatId: 'chat-1', mediaBucket: 'visual' }).read().map(row => row.id)).toEqual(expected);
  });
});
