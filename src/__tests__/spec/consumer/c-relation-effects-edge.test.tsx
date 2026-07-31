import { belongsTo, defineModelRuntime, f, hasMany } from '../../testApi';
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
  const chats = defineModelRuntime({
    id: `SpecEffectsChats${suffix}`,
    name: `SpecEffectsChats${suffix}`,
    fields: { unreadCount: f.num(), lastActivityAt: f.num() }
  });
  const messages = defineModelRuntime({
    id: `SpecEffectsMessages${suffix}`,
    name: `SpecEffectsMessages${suffix}`,
    fields: { chatId: f.str(), createdAt: f.num() },
    relations: () => ({
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

describe('relation effect in-batch edges', () => {
  it('nets a same-batch insert and destroy of one child to zero counter effects', () => {
    const { chats, messages } = createChatModels('NetZero');
    const ingest = messages.ingest({
      burst: { handler: () => ({ upsert: { id: 'msg-1', chatId: 'chat-1', createdAt: 1 }, destroy: 'msg-1' }) }
    });

    ingest.apply('burst', {});

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
    expect(messages.find('msg-1')).toBeUndefined();
  });

  it('counts a child appearing twice in one batch exactly once', () => {
    const { chats, messages } = createChatModels('Dedupe');
    const ingest = messages.ingest({
      echo: {
        handler: () => ({
          upsert: [
            { id: 'msg-1', chatId: 'chat-1', createdAt: 1 },
            { id: 'msg-1', chatId: 'chat-1', createdAt: 2 }
          ]
        })
      }
    });

    ingest.apply('echo', {});

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });

  it('ignores an empty foreign key without counting', () => {
    const { chats, messages } = createChatModels('EmptyFk');
    const ingest = messages.ingest({
      orphan: { handler: () => ({ upsert: { id: 'msg-1', chatId: '', createdAt: 1 } }) }
    });

    ingest.apply('orphan', {});

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0, lastActivityAt: 0 });
  });

  it('aggregates touches from several children into one monotonic parent patch per batch', () => {
    const { chats, messages } = createChatModels('TouchAgg');
    const ingest = messages.ingest({
      batch: {
        handler: () => ({
          upsert: [
            { id: 'msg-1', chatId: 'chat-1', createdAt: 5 },
            { id: 'msg-2', chatId: 'chat-1', createdAt: 9 }
          ]
        })
      },
      later: { handler: () => ({ upsert: { id: 'msg-3', chatId: 'chat-1', createdAt: 7 } }) }
    });

    ingest.apply('batch', {});
    expect(chats.find('chat-1')).toMatchObject({ lastActivityAt: 9 });

    ingest.apply('later', {});
    expect(chats.find('chat-1')).toMatchObject({ lastActivityAt: 9 });
  });

  it('trusts an authoritative parent snapshot over a derived counter in the same batch', () => {
    const { chats, messages } = createChatModels('Authoritative');
    const ingest = messages.ingest({
      combined: {
        handler: () => ({
          upsert: { id: 'msg-1', chatId: 'chat-1', createdAt: 1 },
          extract: [{ into: chats, rows: [{ id: 'chat-1', unreadCount: 50, lastActivityAt: 40 }] }]
        })
      }
    });

    ingest.apply('combined', {});

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 50 });
  });

  it('decrements the parent counter exactly once when an existing child is destroyed', () => {
    const { chats, messages } = createChatModels('Decrement');
    const ingest = messages.ingest({
      arrival: { handler: () => ({ upsert: { id: 'msg-1', chatId: 'chat-1', createdAt: 1 } }) },
      removal: { handler: () => ({ destroy: 'msg-1' }) }
    });
    ingest.apply('arrival', {});
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    ingest.apply('removal', {});

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
  });

  it('treats a destroy of an absent parent as a no-op for orphan children carrying its key', () => {
    setupSpecRuntime();
    type Child = { id: string; parentId: string };
    const children = defineModelRuntime({
      id: 'SpecEffectsOrphanChildren',
      name: 'SpecEffectsOrphanChildren',
      fields: { parentId: f.str() }
    });
    const parents = defineModelRuntime({
      id: 'SpecEffectsGhostParents',
      name: 'SpecEffectsGhostParents',
      fields: { label: f.str() },
      relations: () => ({
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
