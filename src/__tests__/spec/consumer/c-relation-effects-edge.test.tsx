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
import { diagnostics, setupSpecRuntime } from '../helpers/harness';

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
          // The app-shaped gate: strictly-newer comparison (server clocks can run behind the
          // optimistic timestamp), plus the follow-the-swap branch driven by ctx.replacedIds.
          touch: (message, chat, ctx) =>
            message.createdAt > chat.lastActivityAt || (chat.lastMessageId !== null && ctx.replacedIds.has(chat.lastMessageId))
              ? { lastMessageId: message.id, lastActivityAt: message.createdAt }
              : null
        })
      })
    });
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0, lastMessageId: null });
    applyEvent(messages, [{ id: 'tmp:1', chatId: 'chat-1', createdAt: 5 }]);
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1, lastMessageId: 'tmp:1' });

    // The response swap: the server row replaces the temp row in one plan, and the server
    // timestamp runs BEHIND the optimistic one. The parent preview must still follow the swap -
    // a dangling reference to the destroyed temp id is the defect class, and client-vs-server
    // clock comparison must never decide it.
    getApplyRuntime().commit(
      createCommitEnvelope([
        { kind: 'upsert', model: messages.key, rows: [{ id: 'srv-1', chatId: 'chat-1', createdAt: 4 }], origin: 'replace' },
        { kind: 'destroy', model: messages.key, ids: ['tmp:1'], origin: 'replace' }
      ])
    );

    expect(messages.find('tmp:1')).toBeUndefined();
    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'srv-1', unreadCount: 1 });
  });

  it('[RE9] keeps plain destroys out of replacedIds: only replace legs drive the follow-the-swap touch', () => {
    setupSpecRuntime();
    const chats = defineModel('SpecEffectsChatsPlainDestroy', {
      schema: defineShape<{ id: string; unreadCount: number; lastActivityAt: number; lastMessageId: string | null }>()({
        unreadCount: f.num(),
        lastActivityAt: f.num(),
        lastMessageId: f.str().nullable()
      })
    });
    const messages = defineModel('SpecEffectsMessagesPlainDestroy', {
      schema: defineShape<Message>()({ chatId: f.str(), createdAt: f.num() }),
      associations: () => ({
        chat: belongsTo<Message, { id: string; unreadCount: number; lastActivityAt: number; lastMessageId: string | null }>(chats, {
          foreignKey: 'chatId',
          counterCache: { field: 'unreadCount' },
          touch: (message, chat, ctx) =>
            message.createdAt > chat.lastActivityAt || (chat.lastMessageId !== null && ctx.replacedIds.has(chat.lastMessageId))
              ? { lastMessageId: message.id, lastActivityAt: message.createdAt }
              : null
        })
      })
    });
    chats.insert({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0, lastMessageId: null });
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-1', createdAt: 10 }]);
    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'msg-1', unreadCount: 1 });

    // A PLAIN destroy of the referenced message plus an OLDER insert in one plan: the destroyed
    // id is not a replace leg, so the follow-the-swap branch must not fire - the preview keeps
    // the destroyed reference instead of jumping backwards in time.
    getApplyRuntime().commit(
      createCommitEnvelope([
        { kind: 'destroy', model: messages.key, ids: ['msg-1'] },
        { kind: 'upsert', model: messages.key, rows: [{ id: 'msg-0', chatId: 'chat-1', createdAt: 5 }], origin: 'event' }
      ])
    );

    expect(chats.find('chat-1')).toMatchObject({ lastMessageId: 'msg-1', unreadCount: 1 });
  });

  it('[RE10] runs no relation effects for snapshot-origin upserts', () => {
    const { chats, messages } = createChatModels('SnapshotSilent');
    getApplyRuntime().commit(
      createCommitEnvelope([{ kind: 'upsert', model: messages.key, rows: [{ id: 'msg-1', chatId: 'chat-1', createdAt: 99 }] }])
    );

    // The snapshot pocket of the effect matrix: no counter, no touch - authority came from the
    // server snapshot, not from an observed event.
    expect(chats.find('chat-1')).toEqual({ id: 'chat-1', unreadCount: 0, lastActivityAt: 0 });
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

  it('[RE6] restores the parent counter when a failed destroy rolls its child back', () => {
    setupSpecRuntime();
    const { chats, messages } = createChatModels('RollbackCounter');
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-1', createdAt: 1 }]);
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });

    // The write and rollback paths are symmetric: the destroy leg took the counter to 0, so
    // the restore leg of the SAME operation must bring it back to 1 - a rollback that leaves
    // the parent undercounted is partial state.
    getApplyRuntime().commit(createCommitEnvelope([{ kind: 'destroy', model: messages.key, ids: ['msg-1'] }]));
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 0 });
    const restorePlan = getInternalModelHandle(messages).planRestore({ id: 'msg-1', chatId: 'chat-1', createdAt: 1 }, []);
    getApplyRuntime().commit(createCommitEnvelope(restorePlan));

    expect(messages.find('msg-1')).toMatchObject({ chatId: 'chat-1' });
    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 1 });
  });

  it('[RE7] treats a destroy of an absent parent as a no-op for orphan children carrying its key', () => {
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

describe('relation effect drop observability', () => {
  it('[RE40] skips a counter op aimed at a non-resident parent and counts the drop', () => {
    setupSpecRuntime();
    const chats = defineModel('SpecEffectsChatsGhostCounter', {
      schema: defineShape<Chat>()({ unreadCount: f.num(), lastActivityAt: f.num() })
    });
    const messages = defineModel('SpecEffectsMessagesGhostCounter', {
      schema: defineShape<Message>()({ chatId: f.str(), createdAt: f.num() }),
      associations: () => ({
        chat: belongsTo<Message, Chat>(chats, { foreignKey: 'chatId', counterCache: { field: 'unreadCount' } })
      })
    });
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-ghost', createdAt: 1 }]);

    expect(chats.find('chat-ghost')).toBeUndefined();
    expect(diagnostics().snapshot().counterOpDrops).toBe(1);
  });

  it('[RE40] skips a counter op over a non-numeric base without fabricating 0', () => {
    setupSpecRuntime();
    type CorruptChat = { id: string; unreadCount: number | string };
    const chats = defineModel('SpecEffectsChatsCorruptBase', {
      schema: defineShape<CorruptChat>()({ unreadCount: f.raw<number | string>() })
    });
    const messages = defineModel('SpecEffectsMessagesCorruptBase', {
      schema: defineShape<Message>()({ chatId: f.str(), createdAt: f.num() }),
      associations: () => ({
        chat: belongsTo<Message, CorruptChat>(chats, { foreignKey: 'chatId', counterCache: { field: 'unreadCount' } })
      })
    });
    chats.insert({ id: 'chat-1', unreadCount: 'corrupt' });
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-1', createdAt: 1 }]);

    expect(chats.find('chat-1')).toMatchObject({ unreadCount: 'corrupt' });
    expect(diagnostics().snapshot().counterOpDrops).toBe(1);
  });

  it('[RE41] counts a touch effect dropped for a non-resident parent', () => {
    setupSpecRuntime();
    const chats = defineModel('SpecEffectsChatsGhostTouch', {
      schema: defineShape<Chat>()({ unreadCount: f.num(), lastActivityAt: f.num() })
    });
    const messages = defineModel('SpecEffectsMessagesGhostTouch', {
      schema: defineShape<Message>()({ chatId: f.str(), createdAt: f.num() }),
      associations: () => ({
        chat: belongsTo<Message, Chat>(chats, {
          foreignKey: 'chatId',
          touch: (message, chat) => (message.createdAt > chat.lastActivityAt ? { lastActivityAt: message.createdAt } : null)
        })
      })
    });
    applyEvent(messages, [{ id: 'msg-1', chatId: 'chat-ghost', createdAt: 5 }]);

    expect(chats.find('chat-ghost')).toBeUndefined();
    expect(diagnostics().snapshot().nonResidentTouchDrops).toBe(1);
  });
});
