import {
  belongsTo,
  createCommitEnvelope,
  defineModel,
  defineShape,
  f,
  getApplyRuntime,
  getInternalModelHandle,
  hasMany,
  type WriteOp
} from '../../testApi';
import { setupSpecRuntime } from '../helpers/harness';

/**
 * In-batch relation effect edge contracts (mutation-audit survivors of deriveEffects): counter
 * compensation when a child is born and destroyed in one plan, per-batch dedupe, empty foreign
 * keys, touch aggregation, and the authoritative-parent filter that keeps a same-batch snapshot
 * ahead of derived counters.
 */
type Chat = { id: string; unreadCount: number; lastActivityAt: number };
type Message = { id: string; chatId: string; createdAt: number };

const createChatModels = (suffix: string) => {
  setupSpecRuntime();
  const chats = defineModel(`SpecEffectsChats${suffix}`, {
    schema: defineShape<Chat>()({ unreadCount: f.num(), lastActivityAt: f.num() })
  });
  const messages = defineModel(`SpecEffectsMessages${suffix}`, {
    schema: defineShape<Message>()({ chatId: f.str(), createdAt: f.num() }),
    associations: () => ({
      chat: belongsTo<Message, Chat>(chats, {
        foreignKey: 'chatId',
        counterCache: { field: 'unreadCount' },
        touch: (message, chat) => (message.createdAt > chat.lastActivityAt ? { lastActivityAt: message.createdAt } : null)
      })
    })
  });
  chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0 });
  return { chats, messages };
};

const applyEvent = <TModel extends { key: string }>(model: TModel, rows: readonly unknown[], extra: WriteOp[] = []): void => {
  const plan = getInternalModelHandle(model).planRows([...rows], { origin: 'event' });
  getApplyRuntime().commit(createCommitEnvelope([...plan, ...extra]));
};

describe('relation effect in-batch edges', () => {
  it('nets a same-batch insert and destroy of one child to zero counter effects', () => {
    const { chats, messages } = createChatModels('NetZero');
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-1', createdAt: 1 }], [
      { kind: 'destroy', model: messages.key, ids: ['msg-1'] }
    ]);

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
    expect(messages.find('msg-1')).toBeUndefined();
  });

  it('counts a child appearing twice in one batch exactly once', () => {
    const { chats, messages } = createChatModels('Dedupe');
    applyEvent(messages, [
      { id: 'msg-1', chatId: 'chat-1', createdAt: 1 },
      { id: 'msg-1', chatId: 'chat-1', createdAt: 2 }
    ]);

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });

  it('ignores an empty foreign key without counting', () => {
    const { chats, messages } = createChatModels('EmptyFk');
    applyEvent(messages, [{ id: 'msg-1', chatId: '', createdAt: 1 }]);

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0, lastActivityAt: 0 });
  });

  it('aggregates touches from several children into one monotonic parent patch per batch', () => {
    const { chats, messages } = createChatModels('TouchAgg');
    applyEvent(messages, [
      { id: 'msg-1', chatId: 'chat-1', createdAt: 5 },
      { id: 'msg-2', chatId: 'chat-1', createdAt: 9 }
    ]);
    expect(chats.find('chat-1')).toMatchObject({ lastActivityAt: 9 });

    applyEvent(messages, [{ id: 'msg-3', chatId: 'chat-1', createdAt: 7 }]);
    expect(chats.find('chat-1')).toMatchObject({ lastActivityAt: 9 });
  });

  it('lets the replace upsert leg touch the parent so the preview follows the swap', () => {
    setupSpecRuntime();
    const chats = defineModel('SpecEffectsChatsSwapTouch', {
      schema: defineShape<{ id: string; unreadCount: number; lastActivityAt: number; lastMessageId: string | null }>()({
        unreadCount: f.num(),
        lastActivityAt: f.num(),
        lastMessageId: f.str().nullable()
      })
    });
    const messages = defineModel('SpecEffectsMessagesSwapTouch', {
      schema: defineShape<Message>()({ chatId: f.str(), createdAt: f.num() }),
      associations: () => ({
        chat: belongsTo<Message, { id: string; unreadCount: number; lastActivityAt: number; lastMessageId: string | null }>(chats, {
          foreignKey: 'chatId',
          counterCache: { field: 'unreadCount' },
          touch: (message, chat) => (message.createdAt >= chat.lastActivityAt ? { lastMessageId: message.id, lastActivityAt: message.createdAt } : null)
        })
      })
    });
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0, lastMessageId: null });
    applyEvent(messages, [{ id: 'tmp:1', chatId: 'chat-1', createdAt: 5 }]);
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'tmp:1' });

    // The response swap: the server row replaces the temp row in one plan. The parent preview
    // must follow the swap - a dangling reference to the destroyed temp id is the defect class.
    getApplyRuntime().commit(
      createCommitEnvelope([
        { kind: 'upsert', model: messages.key, rows: [{ id: 'srv-1', chatId: 'chat-1', createdAt: 5 }], origin: 'replace' },
        { kind: 'destroy', model: messages.key, ids: ['tmp:1'], origin: 'replace' }
      ])
    );

    expect(messages.find('tmp:1')).toBeUndefined();
    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'srv-1', unreadCount: 1 });
  });

  it('trusts an authoritative parent snapshot over a derived counter in the same batch', () => {
    const { chats, messages } = createChatModels('Authoritative');
    const parentPlan = getInternalModelHandle(chats).planRows([{ id: 'chat-1', unreadCount: 50, lastActivityAt: 40 }], { origin: 'event' });
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-1', createdAt: 1 }], parentPlan);

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 50 });
  });

  it('decrements the parent counter exactly once when an existing child is destroyed', () => {
    const { chats, messages } = createChatModels('Decrement');
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-1', createdAt: 1 }]);
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    messages.destroy('msg-1');

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
  });

  it('treats a destroy of an absent parent as a no-op for orphan children carrying its key', () => {
    setupSpecRuntime();
    type Child = { id: string; parentId: string };
    const children = defineModel('SpecEffectsOrphanChildren', {
      schema: defineShape<Child>()({ parentId: f.str() })
    });
    const parents = defineModel('SpecEffectsGhostParents', {
      schema: defineShape<{ id: string; label: string }>()({ label: f.str() }),
      associations: () => ({
        children: hasMany<{ id: string; label: string }, Child>(children, { foreignKey: 'parentId', dependent: 'destroy' })
      })
    });
    children.insert({ id: 'orphan-1', parentId: 'ghost' });

    // The parent row never existed: destroying its id must not cascade into rows that merely
    // reference it - only a live parent owns cascade authority.
    parents.destroy('ghost');

    expect(children.find('orphan-1')).toMatchObject({ parentId: 'ghost' });
  });
});
