import { belongsTo, configureDb, defineModelRuntime, f, bootDb, DB_FORMAT_VERSION, computeSchemaFingerprints, writePersistenceManifest } from '../../testApi';
import { createMemoryPlane, createMockTransport } from '../helpers/harness';

type Chat = { id: string; unreadCount: number; lastMessageId: string | null; lastActivityAt: number };
type Message = { id: string; chatId: string; body: string; createdAt: number };

describe('effects derive from accepted rows', () => {
  it('rehydrates derived relation state without invoking relation callbacks', async () => {
    const storage = createMemoryPlane();
    const replayTouch = jest.fn((_message: Message, _chat: Chat) => {
      throw new Error('relation callback ran during replay');
    });
    const defineRows = (replaying = false) => {
      const chats = defineModelRuntime({ id: 'EffectsAcceptanceReplayChat', name: 'EffectsAcceptanceReplayChat',  fields: { unreadCount: f.num(), lastMessageId: f.str().nullable(), lastActivityAt: f.num() } });
      const messages = defineModelRuntime({
        id: 'EffectsAcceptanceReplayMessage',
        name: 'EffectsAcceptanceReplayMessage',
        
        fields: { chatId: f.str(), body: f.str(), createdAt: f.num() },
        relations: () => ({
          chat: belongsTo<Message, Chat>(chats, {
            foreignKey: 'chatId',
            touch: replaying
              ? replayTouch
              : (message, chat) => ({ lastMessageId: message.id, lastActivityAt: Math.max(chat.lastActivityAt, message.createdAt) }),
            counterCache: { field: 'unreadCount' }
          })
        })
      });
      return { chats, messages };
    };
    configureDb({ storage, transport: createMockTransport() });
    const first = defineRows();
    writePersistenceManifest('dbl:', { formatVersion: DB_FORMAT_VERSION, schemaFingerprints: computeSchemaFingerprints(), dataVersion: null });
    first.chats.insert({ id: 'chat-1', unreadCount: 0, lastMessageId: null, lastActivityAt: 0 });
    first.messages.insert({ id: 'message-1', chatId: 'chat-1', body: 'stored', createdAt: 1 });

    expect(first.chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'message-1' });

    configureDb({ storage, transport: createMockTransport() });
    const replayed = defineRows(true);
    await expect(bootDb()).resolves.toMatchObject({ reset: false });

    expect(replayTouch).not.toHaveBeenCalled();
    expect(replayed.messages.find('message-1')).toMatchObject({ chatId: 'chat-1', body: 'stored' });
    expect(replayed.chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'message-1' });
  });

  it('runs relation callbacks once during planning', () => {
    const storage = createMemoryPlane();
    let touchCalls = 0;
    configureDb({ storage, transport: createMockTransport() });
    const chats = defineModelRuntime({
      id: 'EffectsAcceptancePreflightChat',
      name: 'EffectsAcceptancePreflightChat',
      fields: { unreadCount: f.num(), lastMessageId: f.str().nullable(), lastActivityAt: f.num() }
    });
    const messages = defineModelRuntime({
      id: 'EffectsAcceptancePreflightMessage',
      name: 'EffectsAcceptancePreflightMessage',
      fields: { chatId: f.str(), body: f.str(), createdAt: f.num() },
      relations: () => ({
        chat: belongsTo<Message, Chat>(chats, {
          foreignKey: 'chatId',
          touch: message => {
            touchCalls += 1;
            return { lastMessageId: message.id, lastActivityAt: message.createdAt };
          },
          counterCache: { field: 'unreadCount' }
        })
      })
    });
    chats.insert({ id: 'chat-1', unreadCount: 0, lastMessageId: null, lastActivityAt: 0 });

    messages.insert({ id: 'message-1', chatId: 'chat-1', body: 'stored', createdAt: 1 });

    expect(touchCalls).toBe(1);
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'message-1' });
  });
});
