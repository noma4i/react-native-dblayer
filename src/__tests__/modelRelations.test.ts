import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { belongsTo, configureDb, defineModel, devClearAllDataAndState, f, hasMany, hasManyThrough, pickEqual, pruneOrphanedRows, stableSerialize } from '../index';
import type { CollectionModel, InternalSyncContract, ModelRelationsConfig, RelatedSurface, RowRelatedSurface } from '../types';
import { installMemoryStorage, mockTransport } from './helpers/testRuntime';

type UserRow = { id: string; name: string; orgId?: string | null; updatedAt?: string | null };
type ChatRow = { id: string; userId: string; title: string; updatedAt?: string | null };
type MessageRow = { id: string; chatId: string; userId?: string | null; body: string; updatedAt?: string | null };
type OrgRow = { id: string; name: string; updatedAt?: string | null };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

type HookResult<TProps, TResult> = {
  current: TResult;
  flush: () => Promise<void>;
  rerender: (props: TProps) => void;
  unmount: () => void;
};

const renderHook = <TProps, TResult>(read: (props: TProps) => TResult, initialProps: TProps): HookResult<TProps, TResult> => {
  let current!: TResult;
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = ({ props }: { props: TProps }) => {
    current = read(props);
    return null;
  };

  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness, { props: initialProps }));
  });

  return {
    get current() {
      return current;
    },
    async flush() {
      await flush();
    },
    rerender(props) {
      act(() => {
        renderer.update(React.createElement(Harness, { props }));
      });
    },
    unmount() {
      act(() => {
        renderer.unmount();
      });
    }
  };
};

function defineUserModel(id: string): CollectionModel<Partial<UserRow> & { id: string }, UserRow>;
function defineUserModel<TRelations extends ModelRelationsConfig>(
  id: string,
  relations: () => TRelations
): CollectionModel<Partial<UserRow> & { id: string }, UserRow & RowRelatedSurface<TRelations>> & RelatedSurface<TRelations>;
function defineUserModel(id: string, relations?: () => ModelRelationsConfig): any {
  const config = {
    id,
    name: `RelationUserModel:${id}`,
    normalize: (input: Partial<UserRow> & { id: string }) => ({
      id: input.id,
      name: input.name ?? input.id,
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      updatedAt: input.updatedAt ?? null
    }),
    merge: {},
    replace: {}
  };

  return relations
    ? defineModel<Partial<UserRow> & { id: string }, UserRow>({ ...config, relations })
    : defineModel<Partial<UserRow> & { id: string }, UserRow>(config);
}

function defineChatModel(id: string): CollectionModel<Partial<ChatRow> & { id: string; userId: string }, ChatRow>;
function defineChatModel<TRelations extends ModelRelationsConfig>(
  id: string,
  relations: () => TRelations
): CollectionModel<Partial<ChatRow> & { id: string; userId: string }, ChatRow & RowRelatedSurface<TRelations>> & RelatedSurface<TRelations>;
function defineChatModel(id: string, relations?: () => ModelRelationsConfig): any {
  const config = {
    id,
    name: `RelationChatModel:${id}`,
    normalize: (input: Partial<ChatRow> & { id: string; userId: string }) => ({
      id: input.id,
      userId: input.userId,
      title: input.title ?? input.id,
      updatedAt: input.updatedAt ?? null
    }),
    merge: {},
    replace: {}
  };

  return relations
    ? defineModel<Partial<ChatRow> & { id: string; userId: string }, ChatRow>({ ...config, relations })
    : defineModel<Partial<ChatRow> & { id: string; userId: string }, ChatRow>(config);
}

function defineMessageModel(id: string): CollectionModel<Partial<MessageRow> & { id: string; chatId: string }, MessageRow>;
function defineMessageModel<TRelations extends ModelRelationsConfig>(
  id: string,
  relations: () => TRelations
): CollectionModel<Partial<MessageRow> & { id: string; chatId: string }, MessageRow & RowRelatedSurface<TRelations>> & RelatedSurface<TRelations>;
function defineMessageModel(id: string, relations?: () => ModelRelationsConfig): any {
  const config = {
    id,
    name: `RelationMessageModel:${id}`,
    normalize: (input: Partial<MessageRow> & { id: string; chatId: string }) => ({
      id: input.id,
      chatId: input.chatId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      body: input.body ?? input.id,
      updatedAt: input.updatedAt ?? null
    }),
    merge: {},
    replace: {}
  };

  return relations
    ? defineModel<Partial<MessageRow> & { id: string; chatId: string }, MessageRow>({ ...config, relations })
    : defineModel<Partial<MessageRow> & { id: string; chatId: string }, MessageRow>(config);
}

const defineOrgModel = (id: string) =>
  defineModel<Partial<OrgRow> & { id: string }, OrgRow>({
    id,
    name: `RelationOrgModel:${id}`,
    normalize: input => ({
      id: input.id,
      name: input.name ?? input.id,
      updatedAt: input.updatedAt ?? null
    }),
    merge: {},
    replace: {}
  });

describe('model relations', () => {
  afterEach(async () => {
    await flush();
    devClearAllDataAndState();
    configureDb({ transport: mockTransport({}), modelDefaults: {} });
  });

  it('enforces hasMany foreign keys against child string fields', () => {
    installMemoryStorage();
    const userModel = defineUserModel('relation-types-user');
    const messageModel = defineMessageModel('relation-types-message');

    hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' });
    belongsTo(userModel, { foreignKey: 'userId' });

    if (false) {
      // @ts-expect-error missing keys are not valid child foreign keys
      hasMany(messageModel, { foreignKey: 'missingId', dependent: 'destroy' });
      // @ts-expect-error dependent supports only destroy for now
      hasMany(messageModel, { foreignKey: 'chatId', dependent: 'nullify' });
      // @ts-expect-error belongsTo does not accept dependent options
      belongsTo(userModel, { foreignKey: 'userId', dependent: 'destroy' });
    }
  });

  it('accepts statics-extended fields models in hasMany without casts', () => {
    installMemoryStorage();
    const messageModel = defineModel({
      id: 'relation-fields-statics-message',
      name: 'RelationFieldsStaticsMessageModel',
      fields: {
        chatId: f.id(),
        body: f.str(),
        readCount: f.num().default(0)
      },
      statics: model => ({
        firstBody: () => model.getFirst()?.body
      })
    });

    hasMany(messageModel, { foreignKey: 'chatId' });
    hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' });
    expect(messageModel.firstBody()).toBeUndefined();

    if (false) {
      // @ts-expect-error numeric fields are not valid hasMany foreign keys
      hasMany(messageModel, { foreignKey: 'readCount' });
      // @ts-expect-error missing keys are not valid hasMany foreign keys
      hasMany(messageModel, { foreignKey: 'missingId' });
    }
  });

  it('exposes direct hasMany related get, use, and count accessors', async () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-direct-chat');
    const userModel = defineUserModel('relation-direct-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Two', updatedAt: null });

    expect(userModel.related.chats.get('user-1').map(row => row.id)).toEqual(['chat-1']);

    const hook = renderHook(
      (parentId: string) => ({
        rows: userModel.related.chats.use(parentId),
        count: userModel.related.chats.count(parentId)
      }),
      'user-1'
    );
    await hook.flush();

    expect(hook.current.rows.map(row => row.id)).toEqual(['chat-1']);
    expect(hook.current.count).toBe(1);

    act(() => {
      chatModel.patch('chat-2', { userId: 'user-1', updatedAt: '2026-01-02T00:00:00.000Z' });
    });
    await hook.flush();

    expect(hook.current.rows.map(row => row.id).sort()).toEqual(['chat-1', 'chat-2']);
    expect(hook.current.count).toBe(2);

    act(() => {
      chatModel.destroy('chat-1');
    });
    await hook.flush();

    expect(hook.current.rows.map(row => row.id)).toEqual(['chat-2']);
    expect(hook.current.count).toBe(1);

    hook.unmount();
  });

  it('keeps hasMany without dependent query-only and out of cascade destroy', async () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-query-only-chat');
    const userModel = defineUserModel('relation-query-only-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });

    expect(userModel.related.chats.get('user-1').map(row => row.id)).toEqual(['chat-1']);
    const hook = renderHook((parentId: string) => userModel.related.chats.count(parentId), 'user-1');
    await hook.flush();
    expect(hook.current).toBe(1);
    hook.unmount();

    expect(userModel.destroy('user-1')).toBe(true);

    expect(userModel.get('user-1')).toBeUndefined();
    expect(chatModel.get('chat-1')).toEqual(expect.objectContaining({ id: 'chat-1', userId: 'user-1' }));
  });

  it('keeps nullish related reads empty and stable', async () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-nullish-chat');
    const userModel = defineUserModel('relation-nullish-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    expect(userModel.related.chats.get(null)).toEqual([]);
    expect(userModel.related.chats.get(undefined)).toEqual([]);

    const hook = renderHook<
      string | null | undefined,
      { rows: ChatRow[]; count: number }
    >(
      (parentId: string | null | undefined) => ({
        rows: userModel.related.chats.use(parentId),
        count: userModel.related.chats.count(parentId)
      }),
      undefined
    );
    await hook.flush();
    const firstRows = hook.current.rows;

    hook.rerender(null as string | null | undefined);
    await hook.flush();

    expect(hook.current.rows).toBe(firstRows);
    expect(hook.current.rows).toEqual([]);
    expect(hook.current.count).toBe(0);

    act(() => {
      chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    });
    await hook.flush();

    expect(hook.current.rows).toBe(firstRows);
    expect(hook.current.count).toBe(0);

    hook.unmount();
  });

  it('exposes hasManyThrough related get and reactive use accessors', async () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-through-message');
    const chatRelations = () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    });
    const chatModel = defineChatModel('relation-through-chat', chatRelations);
    const userRelations = () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' }),
      messages: hasManyThrough({ through: 'chats', source: 'messages' })
    });
    const userModel = defineUserModel('relation-through-user', userRelations);

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Two', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'One', updatedAt: null });
    messageModel.insertStored({ id: 'message-2', chatId: 'chat-2', body: 'Two', updatedAt: null });
    messageModel.insertStored({ id: 'message-3', chatId: 'chat-3', body: 'Three', updatedAt: null });

    expect(userModel.related.messages.get('user-1').map(row => row.id)).toEqual(['message-1']);

    const hook = renderHook(
      (parentId: string) => ({
        rows: userModel.related.messages.use(parentId),
        count: userModel.related.messages.count(parentId)
      }),
      'user-1'
    );
    await hook.flush();

    expect(hook.current.rows.map(row => row.id)).toEqual(['message-1']);
    expect(hook.current.count).toBe(1);

    act(() => {
      chatModel.insertStored({ id: 'chat-3', userId: 'user-1', title: 'Three', updatedAt: null });
    });
    await hook.flush();

    expect(hook.current.rows.map(row => row.id).sort()).toEqual(['message-1', 'message-3']);
    expect(hook.current.count).toBe(2);

    act(() => {
      messageModel.insertStored({ id: 'message-4', chatId: 'chat-1', body: 'Four', updatedAt: null });
    });
    await hook.flush();

    expect(hook.current.rows.map(row => row.id).sort()).toEqual(['message-1', 'message-3', 'message-4']);
    expect(hook.current.count).toBe(3);

    hook.unmount();
  });

  it('exposes row-level related snapshots for find, get, and through relations', async () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-row-message');
    const chatRelations = () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    });
    const chatModel = defineChatModel('relation-row-chat', chatRelations);
    const userRelations = () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' }),
      messages: hasManyThrough({ through: 'chats', source: 'messages' })
    });
    const userModel = defineUserModel('relation-row-user', userRelations);

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    userModel.insertStored({ id: 'user-2', name: 'Grace', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    chatModel.insertStored({ id: 'chat-2', userId: 'user-2', title: 'Two', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'One', updatedAt: null });
    messageModel.insertStored({ id: 'message-2', chatId: 'chat-2', body: 'Two', updatedAt: null });

    const findHook = renderHook((id: string) => userModel.find(id), 'user-1');
    await findHook.flush();

    expect(findHook.current?.related.chats.map(row => row.id)).toEqual(['chat-1']);
    expect(chatModel.get('chat-1')?.related.messages.map(row => row.id)).toEqual(['message-1']);
    expect(userModel.get('user-1')?.related.messages.map(row => row.id)).toEqual(['message-1']);

    findHook.unmount();
  });

  it('keeps row-level related reads as live snapshots without hook subscriptions', () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-row-snapshot-chat');
    const userModel = defineUserModel('relation-row-snapshot-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    const row = userModel.get('user-1');
    expect(row).toBeDefined();
    expect(row?.related.chats).toEqual([]);

    const related = row!.related;
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });

    expect(row!.related).toBe(related);
    expect(row!.related.chats.map(chat => chat.id)).toEqual(['chat-1']);
  });

  it('keeps row-level related invisible to plain data and restores it after hydration', async () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-row-plain-message');
    const chatRelations = () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    });
    const chatModel = defineChatModel('relation-row-plain-chat', chatRelations);
    const userModel = defineUserModel('relation-row-plain-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'One', updatedAt: null });

    const row = userModel.get('user-1')!;
    expect(row.related.chats.map(chat => chat.id)).toEqual(['chat-1']);
    expect(Object.keys(row)).not.toContain('related');
    expect('related' in { ...row }).toBe(false);
    expect(JSON.stringify(row)).not.toContain('related');
    expect(stableSerialize(row)).not.toContain('related');
    expect(pickEqual<UserRow>(row, { id: 'user-1', name: 'Ada', updatedAt: null }, ['id', 'name', 'updatedAt'])).toBe(true);

    await flush();

    const hydratedMessageModel = defineMessageModel('relation-row-plain-message');
    const hydratedChatRelations = () => ({
      messages: hasMany(hydratedMessageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    });
    const hydratedChatModel = defineChatModel('relation-row-plain-chat', hydratedChatRelations);
    const hydratedUserModel = defineUserModel('relation-row-plain-user', () => ({
      chats: hasMany(hydratedChatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    await Promise.all([hydratedUserModel.collection.stateWhenReady(), hydratedChatModel.collection.stateWhenReady(), hydratedMessageModel.collection.stateWhenReady()]);

    expect(hydratedUserModel.get('user-1')?.related.chats.map(chat => chat.id)).toEqual(['chat-1']);
    expect(hydratedChatModel.get('chat-1')?.related.messages.map(message => message.id)).toEqual(['message-1']);
  });

  it('preserves row identity and caches each row related record', () => {
    installMemoryStorage();
    const chatModel = defineChatModel('relation-row-identity-chat');
    const userModel = defineUserModel('relation-row-identity-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });

    const row = userModel.get('user-1')!;
    expect(userModel.get('user-1')).toBe(row);
    expect(userModel.getAll()[0]).toBe(row);
    expect(userModel.getWhere({ id: 'user-1' })[0]).toBe(row);
    expect(row.related).toBe(row.related);
  });

  it('exposes belongsTo get and use accessors', async () => {
    installMemoryStorage();
    const userModel = defineUserModel('relation-belongs-user');
    const messageModel = defineMessageModel('relation-belongs-message', () => ({
      user: belongsTo(userModel, { foreignKey: 'userId' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: '2000-01-01T00:00:00.000Z' });
    userModel.insertStored({ id: 'user-2', name: 'Grace', updatedAt: '2000-01-01T00:00:00.000Z' });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', userId: 'user-1', body: 'One', updatedAt: null });

    expect(messageModel.related.user.get('message-1')?.id).toBe('user-1');
    expect(messageModel.related.user.get(null)).toBeUndefined();
    expect(messageModel.related.user.get(undefined)).toBeUndefined();

    const hook = renderHook<string | null | undefined, UserRow | undefined>(childId => messageModel.related.user.use(childId), undefined);
    await hook.flush();
    expect(hook.current).toBeUndefined();

    act(() => {
      userModel.patch('user-1', { name: 'Ada Updated', updatedAt: '2000-01-02T00:00:00.000Z' });
    });
    await hook.flush();
    expect(hook.current).toBeUndefined();

    hook.rerender('message-1');
    await hook.flush();
    expect(hook.current?.id).toBe('user-1');
    expect(hook.current?.name).toBe('Ada Updated');

    act(() => {
      userModel.patch('user-1', { name: 'Ada Live', updatedAt: '2000-01-03T00:00:00.000Z' });
    });
    await hook.flush();
    expect(hook.current?.name).toBe('Ada Live');

    act(() => {
      messageModel.patch('message-1', { userId: 'user-2', updatedAt: '2000-01-04T00:00:00.000Z' });
    });
    await hook.flush();
    expect(hook.current?.id).toBe('user-2');

    hook.rerender(null);
    await hook.flush();
    expect(hook.current).toBeUndefined();

    hook.unmount();
  });

  it('exposes belongsTo row-level snapshots', () => {
    installMemoryStorage();
    const userModel = defineUserModel('relation-belongs-row-user');
    const messageModel = defineMessageModel('relation-belongs-row-message', () => ({
      user: belongsTo(userModel, { foreignKey: 'userId' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', userId: 'user-1', body: 'One', updatedAt: null });

    const message = messageModel.get('message-1')!;
    expect(message.related.user?.id).toBe('user-1');

    userModel.patch('user-1', { name: 'Ada Snapshot', updatedAt: '2000-01-02T00:00:00.000Z' });
    expect(message.related.user?.name).toBe('Ada Snapshot');
  });

  it('keeps belongsTo out of cascade destroy', () => {
    installMemoryStorage();
    const userModel = defineUserModel('relation-belongs-cascade-user');
    const messageModel = defineMessageModel('relation-belongs-cascade-message', () => ({
      user: belongsTo(userModel, { foreignKey: 'userId' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', userId: 'user-1', body: 'One', updatedAt: null });

    expect(messageModel.destroy('message-1')).toBe(true);
    expect(userModel.get('user-1')?.name).toBe('Ada');

    messageModel.insertStored({ id: 'message-2', chatId: 'chat-1', userId: 'user-1', body: 'Two', updatedAt: null });
    expect(userModel.destroy('user-1')).toBe(true);
    expect(messageModel.get('message-2')?.body).toBe('Two');
  });

  it('touches belongsTo parents only for local child writes', () => {
    installMemoryStorage();
    const userModel = defineUserModel('relation-touch-user');
    const messageModel = defineMessageModel('relation-touch-message', () => ({
      user: belongsTo(userModel, { foreignKey: 'userId', touch: true })
    }));

    userModel.insertStored({ id: 'user-insert', name: 'Insert', updatedAt: '2000-01-01T00:00:00.000Z' });
    messageModel.insertStored({ id: 'message-insert', chatId: 'chat-1', userId: 'user-insert', body: 'Insert', updatedAt: null });
    expect(userModel.get('user-insert')?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');

    userModel.insertStored({ id: 'user-patch', name: 'Patch', updatedAt: '2000-01-01T00:00:00.000Z' });
    messageModel.applyServerData([{ id: 'message-patch', chatId: 'chat-1', userId: 'user-patch', body: 'Patch', updatedAt: '2000-01-01T00:00:00.000Z' }], { mode: 'merge' });
    expect(userModel.get('user-patch')?.updatedAt).toBe('2000-01-01T00:00:00.000Z');
    messageModel.patch('message-patch', { body: 'Patched', updatedAt: '2000-01-02T00:00:00.000Z' });
    expect(userModel.get('user-patch')?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');

    userModel.insertStored({ id: 'user-replace', name: 'Replace', updatedAt: '2000-01-01T00:00:00.000Z' });
    messageModel.applyServerData([{ id: 'message-replace-old', chatId: 'chat-1', userId: 'user-replace', body: 'Old', updatedAt: '2000-01-01T00:00:00.000Z' }], { mode: 'merge' });
    expect(userModel.get('user-replace')?.updatedAt).toBe('2000-01-01T00:00:00.000Z');
    expect(messageModel.replaceRaw('message-replace-old', { id: 'message-replace-new', chatId: 'chat-1', userId: 'user-replace', body: 'New' })).toBe(true);
    expect(userModel.get('user-replace')?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');

    userModel.insertStored({ id: 'user-server', name: 'Server', updatedAt: '2000-01-01T00:00:00.000Z' });
    messageModel.applyServerData([{ id: 'message-server', chatId: 'chat-1', userId: 'user-server', body: 'Server', updatedAt: '2000-01-01T00:00:00.000Z' }], { mode: 'merge' });
    expect(userModel.get('user-server')?.updatedAt).toBe('2000-01-01T00:00:00.000Z');

    userModel.insertStored({ id: 'user-destroy', name: 'Destroy', updatedAt: '2000-01-01T00:00:00.000Z' });
    messageModel.applyServerData([{ id: 'message-destroy', chatId: 'chat-1', userId: 'user-destroy', body: 'Destroy', updatedAt: '2000-01-01T00:00:00.000Z' }], { mode: 'merge' });
    expect(messageModel.destroy('message-destroy')).toBe(true);
    expect(userModel.get('user-destroy')?.updatedAt).toBe('2000-01-01T00:00:00.000Z');

    expect(() => messageModel.insertStored({ id: 'message-missing', chatId: 'chat-1', userId: 'missing-user', body: 'Missing', updatedAt: null })).not.toThrow();
  });

  it('limits belongsTo touch propagation to one level', () => {
    installMemoryStorage();
    const orgModel = defineOrgModel('relation-touch-org');
    const userModel = defineUserModel('relation-touch-chain-user', () => ({
      org: belongsTo(orgModel, { foreignKey: 'orgId', touch: true })
    }));
    const messageModel = defineMessageModel('relation-touch-chain-message', () => ({
      user: belongsTo(userModel, { foreignKey: 'userId', touch: true })
    }));

    orgModel.insertStored({ id: 'org-1', name: 'Org', updatedAt: '2000-01-01T00:00:00.000Z' });
    userModel.applyServerData([{ id: 'user-1', name: 'Ada', orgId: 'org-1', updatedAt: '2000-01-01T00:00:00.000Z' }], { mode: 'merge' });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', userId: 'user-1', body: 'One', updatedAt: null });

    expect(userModel.get('user-1')?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(orgModel.get('org-1')?.updatedAt).toBe('2000-01-01T00:00:00.000Z');
  });

  it('throws model-prefixed errors for invalid hasManyThrough names', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-invalid-message');
    const chatModel = defineChatModel('relation-invalid-chat', () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    }));
    const missingThroughModel = defineUserModel('relation-invalid-through-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' }),
      messages: hasManyThrough({ through: 'missing', source: 'messages' })
    }));
    const missingSourceModel = defineUserModel('relation-invalid-source-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' }),
      messages: hasManyThrough({ through: 'chats', source: 'missing' })
    }));

    expect(() => missingThroughModel.related.messages.get('user-1')).toThrow('[RelationUserModel:relation-invalid-through-user] relation "messages"');
    expect(() => missingSourceModel.related.messages.get('user-1')).toThrow('[RelationUserModel:relation-invalid-source-user] relation "messages"');
  });

  it('infers related keys and child row types from relation configs', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-type-message');
    const chatRelations = () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    });
    const chatModel = defineModel({
      id: 'relation-type-chat',
      name: 'RelationChatModel:relation-type-chat',
      normalize: (input: Partial<ChatRow> & { id: string; userId: string }): ChatRow => ({
        id: input.id,
        userId: input.userId,
        title: input.title ?? input.id,
        updatedAt: input.updatedAt ?? null
      }),
      relations: chatRelations
    });
    const userRelations = () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' }),
      messages: hasManyThrough({ through: 'chats', source: 'messages' })
    });
    const userModel = defineModel({
      id: 'relation-type-user',
      name: 'RelationUserModel:relation-type-user',
      normalize: (input: Partial<UserRow> & { id: string }): UserRow => ({ id: input.id, name: input.name ?? input.id, updatedAt: input.updatedAt ?? null }),
      relations: userRelations
    });

    const chatRows: ChatRow[] = userModel.related.chats.get('user-1');
    const messageRows: MessageRow[] = userModel.related.messages.get('user-1');
    expect(chatRows).toEqual([]);
    expect(messageRows).toEqual([]);
    expect(Object.keys(userModel.related).sort()).toEqual(['chats', 'messages']);

    if (false) {
      // @ts-expect-error unknown relation keys are not exposed
      userModel.related.missing;
      // @ts-expect-error through relation returns message rows, not chat rows
      const wrongRows: ChatRow[] = userModel.related.messages.get('user-1');
      const rowChatRows: ChatRow[] = userModel.get('user-1')!.related.chats;
      const rowMessageRows: MessageRow[] = userModel.get('user-1')!.related.messages;
      const count: number = userModel.related.chats.count('user-1');
      void wrongRows;
      void rowChatRows;
      void rowMessageRows;
      void count;
    }
  });

  it('infers belongsTo accessors and row-chain parent types', () => {
    installMemoryStorage();
    const userModel = defineUserModel('relation-belongs-type-user');
    const messageModel = defineMessageModel('relation-belongs-type-message', () => ({
      user: belongsTo(userModel, { foreignKey: 'userId' })
    }));

    const parentRow: UserRow | undefined = messageModel.related.user.get('message-1');
    const rowParent: UserRow | undefined = messageModel.get('message-1')?.related.user;
    expect(parentRow).toBeUndefined();
    expect(rowParent).toBeUndefined();
    expect(Object.keys(messageModel.related)).toEqual(['user']);

    if (false) {
      // @ts-expect-error singular belongsTo accessors do not expose count
      messageModel.related.user.count('message-1');
      // @ts-expect-error belongsTo returns one parent row, not an array
      const wrongRows: UserRow[] = messageModel.related.user.get('message-1');
      void wrongRows;
    }
  });

  it('keeps helper typed related accessors available for through configs', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-helper-type-message');
    const chatRelations = () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    });
    const chatModel = defineChatModel('relation-helper-type-chat', chatRelations);
    const userRelations = () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' }),
      messages: hasManyThrough({ through: 'chats', source: 'messages' })
    });
    const userModel = defineUserModel('relation-helper-type-user', userRelations);

    const chatRows: ChatRow[] = userModel.related.chats.get('user-1');
    const messageRows: MessageRow[] = userModel.related.messages.get('user-1');
    expect(chatRows).toEqual([]);
    expect(messageRows).toEqual([]);
    expect(Object.keys(userModel.related).sort()).toEqual(['chats', 'messages']);

    if (false) {
      // @ts-expect-error unknown relation keys are not exposed
      userModel.related.missing;
      // @ts-expect-error through relation returns message rows, not chat rows
      const wrongRows: ChatRow[] = userModel.related.messages.get('user-1');
      const rowChatRows: ChatRow[] = userModel.get('user-1')!.related.chats;
      const rowMessageRows: MessageRow[] = userModel.get('user-1')!.related.messages;
      const count: number = userModel.related.chats.count('user-1');
      void wrongRows;
      void rowChatRows;
      void rowMessageRows;
      void count;
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
    chatModel.markFetched({ userId: 'user-1' }, { empty: false });
    chatModel.markFetched({ userId: 'user-2' }, { empty: false });
    messageModel.markFetched({ chatId: 'chat-1' }, { empty: false });
    messageModel.markFetched({ chatId: 'chat-2' }, { empty: false });

    expect(userModel.destroy('user-1')).toBe(true);

    expect(userModel.getAll()).toEqual([]);
    expect(chatModel.getAll().map(row => row.id)).toEqual(['chat-2']);
    expect(messageModel.getAll().map(row => row.id)).toEqual(['message-2']);
    expect(chatModel.getFetchState({ userId: 'user-1' })).toBeNull();
    expect(chatModel.getFetchState({ userId: 'user-2' })).toMatchObject({ empty: false });
    expect(messageModel.getFetchState({ chatId: 'chat-1' })).toBeNull();
    expect(messageModel.getFetchState({ chatId: 'chat-2' })).toMatchObject({ empty: false });
  });

  it('skips hasManyThrough entries during cascade destroy', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-cascade-through-message');
    const chatModel = defineChatModel('relation-cascade-through-chat', () => ({
      messages: hasMany(messageModel, { foreignKey: 'chatId', dependent: 'destroy' })
    }));
    const userModel = defineUserModel('relation-cascade-through-user', () => ({
      chats: hasMany(chatModel, { foreignKey: 'userId', dependent: 'destroy' }),
      invalidThrough: hasManyThrough({ through: 'missing', source: 'messages' })
    }));

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });
    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'Owned', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'Owned', updatedAt: null });

    expect(userModel.destroy('user-1')).toBe(true);

    expect(userModel.getAll()).toEqual([]);
    expect(chatModel.getAll()).toEqual([]);
    expect(messageModel.getAll()).toEqual([]);
  });

  it('terminates cycles without infinite recursion', () => {
    installMemoryStorage();
    type ARow = { id: string; bId: string; updatedAt?: string | null };
    type BRow = { id: string; aId: string; updatedAt?: string | null };
    let aModel!: any;
    let bModel!: any;
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
    const chatRecreatedContract: InternalSyncContract = { mode: 'merge', _freshnessFilter: { userId: 'user-1' } };
    expect(chatModel.applyServerData([{ id: 'chat-1', userId: 'user-1', title: 'Recreated', updatedAt: null }], chatRecreatedContract)).toEqual({ merged: 1 });
    const messageRecreatedContract: InternalSyncContract = { mode: 'merge', _freshnessFilter: { chatId: 'chat-1' } };
    expect(messageModel.applyServerData([{ id: 'message-1', chatId: 'chat-1', body: 'Recreated', updatedAt: null }], messageRecreatedContract)).toEqual({ merged: 1 });
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
    expect('related' in plainModel).toBe(false);
    expect('related' in plainModel.get('plain-1')!).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(plainModel.get('plain-1')!, 'related')).toBe(false);
    expect(relations).toHaveBeenCalledTimes(1);

    if (false) {
      // @ts-expect-error plain rows do not expose row-level relations
      plainModel.get('plain-1')!.related;
    }

    expect(userModel.destroy('missing')).toBe(false);
    expect(relations).toHaveBeenCalledTimes(1);

    expect(userModel.destroy('user-1')).toBe(true);
    expect(userModel.destroy('user-2')).toBe(true);
    expect(relations).toHaveBeenCalledTimes(1);
    expect(chatModel.getAll()).toEqual([]);

    expect(plainModel.destroy('plain-1')).toBe(true);
    expect(plainModel.destroy('missing')).toBe(false);
    expect(plainModel.getAll()).toEqual([]);
  });
});
