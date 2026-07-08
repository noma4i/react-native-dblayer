import { configureDb, defineModel, devClearAllDataAndState, hasMany, pruneOrphanedRows } from '../index';
import type { CollectionModel } from '../types';
import { installMemoryStorage, mockTransport } from './helpers/testRuntime';

type UserRow = { id: string; name: string; updatedAt?: string | null };
type ChatRow = { id: string; userId: string; title: string; updatedAt?: string | null };
type MessageRow = { id: string; chatId: string; body: string; updatedAt?: string | null };

const defineUserModel = (id: string, relations?: () => Record<string, ReturnType<typeof hasMany<unknown, ChatRow, 'userId'>>>) =>
  defineModel<Partial<UserRow> & { id: string }, UserRow>({
    id,
    name: `RelationUserModel:${id}`,
    normalize: input => ({ id: input.id, name: input.name ?? input.id, updatedAt: input.updatedAt ?? null }),
    merge: {},
    replace: {},
    ...(relations ? { relations } : {})
  });

const defineChatModel = (id: string, relations?: () => Record<string, ReturnType<typeof hasMany<unknown, MessageRow, 'chatId'>>>) =>
  defineModel<Partial<ChatRow> & { id: string; userId: string }, ChatRow>({
    id,
    name: `RelationChatModel:${id}`,
    normalize: input => ({
      id: input.id,
      userId: input.userId,
      title: input.title ?? input.id,
      updatedAt: input.updatedAt ?? null
    }),
    merge: {},
    replace: {},
    ...(relations ? { relations } : {})
  });

const defineMessageModel = (id: string) =>
  defineModel<Partial<MessageRow> & { id: string; chatId: string }, MessageRow>({
    id,
    name: `RelationMessageModel:${id}`,
    normalize: input => ({
      id: input.id,
      chatId: input.chatId,
      body: input.body ?? input.id,
      updatedAt: input.updatedAt ?? null
    }),
    merge: {},
    replace: {}
  });

describe('model relations', () => {
  afterEach(() => {
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('enforces hasMany foreign keys against child string fields', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-types-message');

    hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' });

    if (false) {
      // @ts-expect-error missing keys are not valid child foreign keys
      hasMany(messageModel, { foreignKey: 'missingId', dependent: 'destroy' });
      // @ts-expect-error dependent supports only destroy for now
      hasMany(messageModel, { foreignKey: 'chatId', dependent: 'nullify' });
    }
  });

  it('cascades a single-level hasMany destroy', () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-single-chat');
    const userModel = defineUserModel('relation-single-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'Owned', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Other', updatedAt: null });

    expect(userModel.destroy('user-1')).toBe(true);

    expect(userModel.get('user-1')).toBeUndefined();
    expect(chatModel.getAll().map(row => row.id)).toEqual(['chat-2']);
  });

  it('cascades a two-level hasMany chain depth-first', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-chain-message');
    const chatModel = defineChatModel('relation-chain-chat', () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    }));
    const userModel = defineUserModel('relation-chain-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'Owned', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Other', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'Owned', updatedAt: null });
    messageModel.insertStored({ id: 'message-2', chatId: 'chat-2', body: 'Other', updatedAt: null });

    expect(userModel.destroy('user-1')).toBe(true);

    expect(userModel.getAll()).toEqual([]);
    expect(chatModel.getAll().map(row => row.id)).toEqual(['chat-2']);
    expect(messageModel.getAll().map(row => row.id)).toEqual(['message-2']);
  });

  it('terminates cycles without infinite recursion', () => {
    installMemoryStorage();
    type ARow = { id: string; bId: string; updatedAt?: string | null };
    type BRow = { id: string; aId: string; updatedAt?: string | null };
    let aModel!: CollectionModel<unknown, ARow>;
    let bModel!: CollectionModel<unknown, BRow>;
    const aRelations = jest.fn(() => ({
      bs: hasMany(bModel, { foreignKey: 'aId', dependent: 'destroy' })
    }));
    const bRelations = jest.fn(() => ({
      as: hasMany(aModel, { foreignKey: 'bId', dependent: 'destroy' })
    }));

    aModel = defineModel<ARow, ARow>({
      id: 'relation-cycle-a',
      name: 'RelationCycleAModel',
      normalize: input => input,
      relations: aRelations
    });
    bModel = defineModel<BRow, BRow>({
      id: 'relation-cycle-b',
      name: 'RelationCycleBModel',
      normalize: input => input,
      relations: bRelations
    });

    aModel.insertStored({ id: 'a1', bId: 'b1', updatedAt: null });
    aModel.insertStored({ id: 'a2', bId: 'b1', updatedAt: null });
    bModel.insertStored({ id: 'b1', aId: 'a1', updatedAt: null });

    expect(aModel.destroy('a1')).toBe(true);

    expect(aModel.getAll()).toEqual([]);
    expect(bModel.getAll()).toEqual([]);
    expect(aRelations).toHaveBeenCalledTimes(1);
    expect(bRelations).toHaveBeenCalledTimes(1);
  });

  it('cascades destroyMany and destroyWhere through relations', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-bulk-message');
    const chatModel = defineChatModel('relation-bulk-chat', () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    }));
    const userModel = defineUserModel('relation-bulk-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    userModel.insertStored({ id: 'user-2', name: 'Grace', updatedAt: null });
    userModel.insertStored({ id: 'user-3', name: 'Linus', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Two', updatedAt: null });
    chatModel.insertStored({ id: 'chat-3', userId: 'user-3', title: 'Three', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'One', updatedAt: null });
    messageModel.insertStored({ id: 'message-2', chatId: 'chat-2', body: 'Two', updatedAt: null });
    messageModel.insertStored({ id: 'message-3', chatId: 'chat-3', body: 'Three', updatedAt: null });

    expect(userModel.destroyMany(['user-1', 'missing'])).toBe(1);
    expect(userModel.destroyWhere({ name: 'Grace' })).toBe(1);

    expect(userModel.getAll().map(row => row.id)).toEqual(['user-3']);
    expect(chatModel.getAll().map(row => row.id)).toEqual(['chat-3']);
    expect(messageModel.getAll().map(row => row.id)).toEqual(['message-3']);
  });

  it('cascades utilities that route through destroyMany', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-utility-message');
    const chatModel = defineChatModel('relation-utility-chat', () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    }));

    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'Orphan', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Live', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'Orphan', updatedAt: null });
    messageModel.insertStored({ id: 'message-2', chatId: 'chat-2', body: 'Live', updatedAt: null });

    expect(pruneOrphanedRows(chatModel, 'userId', new Set(['user-2']))).toBe(1);

    expect(chatModel.getAll().map(row => row.id)).toEqual(['chat-2']);
    expect(messageModel.getAll().map(row => row.id)).toEqual(['message-2']);
  });

  it('does not cascade server replace-mode removals', () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-replace-chat');
    const userModel = defineUserModel('relation-replace-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.applyServerData([{ id: 'user-1', name: 'Ada', updatedAt: null }], { mode: 'merge' });
    chatModel.applyServerData([{ id: 'chat-1', userId: 'user-1', title: 'Owned', updatedAt: null }], { mode: 'merge' });

    expect(userModel.applyServerData([], { mode: 'replace' })).toEqual({ merged: 0, deleted: 1 });

    expect(userModel.getAll()).toEqual([]);
    expect(chatModel.get('chat-1')?.title).toBe('Owned');
  });

  it('allows cascaded rows to be recreated by later server data and refreshes known-empty freshness', async () => {
    installMemoryStorage();
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const messageModel = defineMessageModel('relation-recreate-message');
    const chatModel = defineChatModel('relation-recreate-chat', () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    }));
    const userModel = defineUserModel('relation-recreate-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'Old', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'Old', updatedAt: null });

    chatModel.markFetched({ userId: 'user-1' }, { empty: true });
    messageModel.markFetched({ chatId: 'chat-1' }, { empty: true });

    expect(userModel.destroy('user-1')).toBe(true);
    expect(chatModel.getAll()).toEqual([]);
    expect(messageModel.getAll()).toEqual([]);
    await Promise.resolve();

    jest.spyOn(Date, 'now').mockReturnValue(1100);
    expect(
      chatModel.applyServerData([{ id: 'chat-1', userId: 'user-1', title: 'Recreated', updatedAt: null }], {
        mode: 'merge',
        _freshnessFilter: { userId: 'user-1' }
      })
    ).toEqual({ merged: 1 });
    expect(
      messageModel.applyServerData([{ id: 'message-1', chatId: 'chat-1', body: 'Recreated', updatedAt: null }], {
        mode: 'merge',
        _freshnessFilter: { chatId: 'chat-1' }
      })
    ).toEqual({ merged: 1 });
    await Promise.resolve();

    expect(chatModel.get('chat-1')).toMatchObject({ title: 'Recreated' });
    expect(messageModel.get('message-1')).toMatchObject({ body: 'Recreated' });
    expect(chatModel.getFetchState({ userId: 'user-1' })).toMatchObject({ touchedAt: 1100, empty: false });
    expect(messageModel.getFetchState({ chatId: 'chat-1' })).toMatchObject({ touchedAt: 1100, empty: false });
    expect(chatModel.shouldSkipInitialFetch({ userId: 'user-1' }, 1000)).toBe(true);
    expect(messageModel.shouldSkipInitialFetch({ chatId: 'chat-1' }, 1000)).toBe(true);
  });

  it('memoizes lazy relation resolution and leaves models without relations on the plain destroy path', () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-lazy-chat');
    const relations = jest.fn(() => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));
    const userModel = defineUserModel('relation-lazy-user', relations);
    const plainModel = defineUserModel('relation-plain-user');

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    userModel.insertStored({ id: 'user-2', name: 'Grace', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Two', updatedAt: null });
    plainModel.insertStored({ id: 'plain-1', name: 'Plain', updatedAt: null });

    expect(userModel.destroy('missing')).toBe(false);
    expect(relations).not.toHaveBeenCalled();

    expect(userModel.destroy('user-1')).toBe(true);
    expect(userModel.destroy('user-2')).toBe(true);
    expect(relations).toHaveBeenCalledTimes(1);
    expect(chatModel.getAll()).toEqual([]);

    expect(plainModel.destroy('plain-1')).toBe(true);
    expect(plainModel.destroy('missing')).toBe(false);
    expect(plainModel.getAll()).toEqual([]);
  });
});
