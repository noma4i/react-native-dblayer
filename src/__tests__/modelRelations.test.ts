import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { belongsTo, configureDb, defineModel, devClearAllDataAndState, f, hasMany, hasOne, hasManyThrough, mergeSyncContract, pickEqual, pruneOrphanedRows, stableSerialize } from '../index';
import { createCollectionModel } from '../core/createCollectionModel';
import { createPersistentCollection } from '../core/createPersistentCollection';
import type { CollectionModel, InternalSyncContract, ModelRelationsConfig, RelatedSurface, RowRelatedSurface } from '../types';
import { installMemoryStorage, mockTransport } from './helpers/testRuntime';

type UserRow = { id: string; name: string; orgId?: string | null; updatedAt?: string | null };
type ChatRow = { id: string; userId: string; title: string; updatedAt?: string | null };
type MessageRow = { id: string; chatId: string; userId?: string | null; body: string; updatedAt?: string | null };
type OrgRow = { id: string; name: string; updatedAt?: string | null };
type MirrorSourceRow = { id: string; name: string; avatarUrl?: string | null; updatedAt?: string | null };
type MirrorTargetRow = { id: string; name: string; avatarUrl?: string | null; updatedAt?: string | null };
type PropagationParentRow = { id: string; title: string; preview?: string | null; lastChildId?: string | null; updatedAt?: string | null };
type PropagationChildRow = { id: string; parentId: string; body: string; updatedAt?: string | null };

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

const defineMirrorTargetModel = (id: string) =>
  defineModel({
    id,
    name: `RelationMirrorTargetModel:${id}`,
    fields: {
      name: f.str(),
      avatarUrl: f.str().nullable(),
      updatedAt: f.str().nullable()
    },
    merge: {},
    replace: {}
  });

const defineMirrorSourceModel = (
  id: string,
  targetModel: ReturnType<typeof defineMirrorTargetModel>,
  project: (row: MirrorSourceRow) => Partial<MirrorTargetRow> | null = row => ({
    name: row.name,
    avatarUrl: row.avatarUrl,
    updatedAt: row.updatedAt
  })
) =>
  defineModel<Partial<MirrorSourceRow> & { id: string }, MirrorSourceRow>({
    id,
    name: `RelationMirrorSourceModel:${id}`,
    normalize: input => ({
      id: input.id,
      name: input.name ?? input.id,
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      updatedAt: input.updatedAt ?? null
    }),
    mirror: [
      {
        model: () => targetModel,
        project
      }
    ],
    merge: {},
    replace: {}
  });

const definePropagationParentModel = (id: string, mirrorTarget?: ReturnType<typeof defineMirrorTargetModel>) =>
  defineModel<Partial<PropagationParentRow> & { id: string }, PropagationParentRow>({
    id,
    name: `RelationPropagationParentModel:${id}`,
    normalize: input => ({
      id: input.id,
      title: input.title ?? input.id,
      ...(input.preview !== undefined ? { preview: input.preview } : {}),
      ...(input.lastChildId !== undefined ? { lastChildId: input.lastChildId } : {}),
      updatedAt: input.updatedAt ?? null
    }),
    ...(mirrorTarget
      ? {
          mirror: [
            {
              model: () => mirrorTarget,
              project: (row: PropagationParentRow) => ({ name: row.title, updatedAt: row.updatedAt })
            }
          ]
        }
      : {}),
    merge: {},
    replace: {}
  });

const definePropagationChildModel = (
  id: string,
  parentModel: ReturnType<typeof definePropagationParentModel>,
  options?: {
    touch?: boolean;
    propagate?: (child: PropagationChildRow, parent: PropagationParentRow) => Partial<PropagationParentRow> | null;
  }
) =>
  defineModel<Partial<PropagationChildRow> & { id: string; parentId: string }, PropagationChildRow>({
    id,
    name: `RelationPropagationChildModel:${id}`,
    normalize: input => ({
      id: input.id,
      parentId: input.parentId,
      body: input.body ?? input.id,
      updatedAt: input.updatedAt ?? null
    }),
    relations: () => ({
      parent: belongsTo(parentModel, {
        foreignKey: 'parentId',
        touch: options?.touch,
        propagate:
          options?.propagate ??
          ((child: PropagationChildRow) => ({
            preview: child.body,
            lastChildId: child.id,
            updatedAt: child.updatedAt
          }))
      })
    }),
    merge: {},
    replace: {}
  });

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

  it('exposes hasOne get, use, and row-chain accessors ordered by comparator', async () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-has-one-message');
    const chatModel = defineChatModel('relation-has-one-chat', () => ({
      lastMessage: hasOne(messageModel, {
        foreignKey: 'chatId',
        comparator: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      })
    }));

    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    messageModel.insertStored({ id: 'message-old', chatId: 'chat-1', body: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' });
    messageModel.insertStored({ id: 'message-new', chatId: 'chat-1', body: 'New', updatedAt: '2026-01-02T00:00:00.000Z' });
    messageModel.insertStored({ id: 'message-other', chatId: 'chat-2', body: 'Other', updatedAt: '2026-01-03T00:00:00.000Z' });

    expect(chatModel.related.lastMessage.get('chat-1')?.id).toBe('message-new');
    expect(chatModel.get('chat-1')?.related.lastMessage?.id).toBe('message-new');
    expect(chatModel.related.lastMessage.get(null)).toBeUndefined();
    expect(chatModel.related.lastMessage.get('chat-empty')).toBeUndefined();

    const hook = renderHook<string | null | undefined, MessageRow | undefined>((chatId: string | null | undefined) => chatModel.related.lastMessage.use(chatId), 'chat-1');
    await hook.flush();

    expect(hook.current?.id).toBe('message-new');

    act(() => {
      messageModel.insertStored({ id: 'message-latest', chatId: 'chat-1', body: 'Latest', updatedAt: '2026-01-04T00:00:00.000Z' });
    });
    await hook.flush();

    expect(hook.current?.id).toBe('message-latest');
    const latest = hook.current;

    act(() => {
      messageModel.insertStored({ id: 'message-unrelated', chatId: 'chat-2', body: 'Unrelated', updatedAt: '2026-01-05T00:00:00.000Z' });
    });
    await hook.flush();

    expect(hook.current).toBe(latest);

    hook.rerender(null);
    await hook.flush();
    expect(hook.current).toBeUndefined();

    hook.unmount();
  });

  it('keeps hasOne query-only and out of cascade destroy', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-has-one-cascade-message');
    const chatModel = defineChatModel('relation-has-one-cascade-chat', () => ({
      lastMessage: hasOne(messageModel, {
        foreignKey: 'chatId',
        comparator: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      })
    }));

    chatModel.insertStored({ id: 'chat-1', userId: 'user-1', title: 'One', updatedAt: null });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', body: 'One', updatedAt: '2026-01-01T00:00:00.000Z' });

    expect(chatModel.destroy('chat-1')).toBe(true);
    expect(chatModel.get('chat-1')).toBeUndefined();
    expect(messageModel.get('message-1')).toEqual(expect.objectContaining({ id: 'message-1', chatId: 'chat-1' }));
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

    await new Promise(resolve => setTimeout(resolve, 350));

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

  it('mirrors local source patches into existing same-id target rows', () => {
    installMemoryStorage();
    const targetModel = defineMirrorTargetModel('mirror-local-target');
    const sourceModel = defineMirrorSourceModel('mirror-local-source', targetModel);

    targetModel.insertStored(targetModel.buildStored({ id: 'user-1', name: 'Existing', avatarUrl: 'https://example.test/old.png' }));
    sourceModel.insertStored({ id: 'user-1', name: 'Ada', avatarUrl: 'https://example.test/a.png', updatedAt: null });
    expect(targetModel.get('user-1')).toMatchObject({ name: 'Ada', avatarUrl: 'https://example.test/a.png' });

    sourceModel.patch('user-1', { name: 'Ada Updated', updatedAt: '2000-01-02T00:00:00.000Z' });
    expect(targetModel.get('user-1')).toMatchObject({ name: 'Ada Updated', avatarUrl: 'https://example.test/a.png' });
  });

  it('inserts missing mirror target rows through the target stored-row builder', () => {
    installMemoryStorage();
    const targetModel = defineMirrorTargetModel('mirror-insert-target');
    const sourceModel = defineMirrorSourceModel('mirror-insert-source', targetModel);

    sourceModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: null });

    expect(targetModel.get('user-1')).toMatchObject({
      id: 'user-1',
      name: 'Ada',
      avatarUrl: null,
      updatedAt: null
    });
  });

  it('skips mirror writes when project returns null', () => {
    installMemoryStorage();
    const targetModel = defineMirrorTargetModel('mirror-null-target');
    const sourceModel = defineMirrorSourceModel('mirror-null-source', targetModel, row => (row.name === 'Skip' ? null : { name: row.name }));

    sourceModel.insertStored({ id: 'user-1', name: 'Skip', updatedAt: null });
    sourceModel.insertStored({ id: 'user-2', name: 'Keep', updatedAt: null });

    expect(targetModel.get('user-1')).toBeUndefined();
    expect(targetModel.get('user-2')).toMatchObject({ name: 'Keep' });
  });

  it('mirrors applyServerData writes from the source model', () => {
    installMemoryStorage();
    const targetModel = defineMirrorTargetModel('mirror-server-target');
    const sourceModel = defineMirrorSourceModel('mirror-server-source', targetModel);

    sourceModel.applyServerData([{ id: 'user-1', name: 'Server', avatarUrl: 'https://example.test/server.png', updatedAt: '2000-01-01T00:00:00.000Z' }], { mode: 'merge' });

    expect(targetModel.get('user-1')).toMatchObject({
      name: 'Server',
      avatarUrl: 'https://example.test/server.png',
      updatedAt: '2000-01-01T00:00:00.000Z'
    });
  });

  it('drops undefined mirror projection keys before writing the target', () => {
    installMemoryStorage();
    const targetModel = defineMirrorTargetModel('mirror-defined-target');
    const sourceModel = defineMirrorSourceModel('mirror-defined-source', targetModel, row => ({
      name: row.name,
      avatarUrl: undefined,
      updatedAt: row.updatedAt
    }));

    targetModel.insertStored(targetModel.buildStored({ id: 'user-1', name: 'Existing', avatarUrl: 'https://example.test/old.png' }));
    sourceModel.insertStored({ id: 'user-1', name: 'Ada', avatarUrl: 'https://example.test/new.png', updatedAt: null });

    expect(targetModel.get('user-1')).toMatchObject({
      name: 'Ada',
      avatarUrl: 'https://example.test/old.png'
    });
  });

  it('does not re-enter propagation for mutual mirrors', () => {
    installMemoryStorage();
    type MirrorPairRow = { id: string; label: string; updatedAt?: string | null };
    let aModel!: CollectionModel<Partial<MirrorPairRow> & { id: string }, MirrorPairRow>;
    let bModel!: CollectionModel<Partial<MirrorPairRow> & { id: string }, MirrorPairRow>;
    const definePairModel = (id: string, target: () => CollectionModel<Partial<MirrorPairRow> & { id: string }, MirrorPairRow>) =>
      defineModel<Partial<MirrorPairRow> & { id: string }, MirrorPairRow>({
        id,
        name: `RelationMirrorPairModel:${id}`,
        normalize: input => ({
          id: input.id,
          label: input.label ?? input.id,
          updatedAt: input.updatedAt ?? null
        }),
        mirror: [
          {
            model: target,
            project: row => ({ label: row.label, updatedAt: row.updatedAt })
          }
        ],
        merge: {},
        replace: {}
      });

    aModel = definePairModel('mirror-mutual-a', () => bModel);
    bModel = definePairModel('mirror-mutual-b', () => aModel);

    aModel.insertStored({ id: 'pair-1', label: 'A', updatedAt: null });
    expect(aModel.get('pair-1')?.label).toBe('A');
    expect(bModel.get('pair-1')?.label).toBe('A');

    bModel.patch('pair-1', { label: 'B', updatedAt: '2000-01-02T00:00:00.000Z' });
    expect(aModel.get('pair-1')?.label).toBe('B');
    expect(bModel.get('pair-1')?.label).toBe('B');
  });

  it('keeps relation touch and mirror propagation on the same local write', () => {
    installMemoryStorage();
    const userModel = defineUserModel('relation-touch-mirror-user');
    const mirrorModel = defineModel<Partial<MessageRow> & { id: string; chatId: string }, MessageRow>({
      id: 'relation-touch-mirror-target',
      name: 'RelationTouchMirrorTarget',
      normalize: input => ({
        id: input.id,
        chatId: input.chatId,
        body: input.body ?? input.id,
        updatedAt: input.updatedAt ?? null
      }),
      merge: {},
      replace: {}
    });
    const messageModel = defineModel<Partial<MessageRow> & { id: string; chatId: string }, MessageRow>({
      id: 'relation-touch-mirror-message',
      name: 'RelationTouchMirrorMessage',
      normalize: input => ({
        id: input.id,
        chatId: input.chatId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        body: input.body ?? input.id,
        updatedAt: input.updatedAt ?? null
      }),
      relations: () => ({
        user: belongsTo(userModel, { foreignKey: 'userId', touch: true })
      }),
      mirror: [
        {
          model: () => mirrorModel,
          project: row => ({ chatId: row.chatId, body: row.body, updatedAt: row.updatedAt })
        }
      ],
      merge: {},
      replace: {}
    });

    userModel.insertStored({ id: 'user-1', name: 'Ada', updatedAt: '2000-01-01T00:00:00.000Z' });
    messageModel.insertStored({ id: 'message-1', chatId: 'chat-1', userId: 'user-1', body: 'One', updatedAt: null });

    expect(userModel.get('user-1')?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(mirrorModel.get('message-1')).toMatchObject({ chatId: 'chat-1', body: 'One' });
  });

  it('propagates local child inserts into existing parent rows', () => {
    installMemoryStorage();
    const parentModel = definePropagationParentModel('propagate-local-parent');
    const childModel = definePropagationChildModel('propagate-local-child', parentModel);

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.insertStored({ id: 'child-1', parentId: 'parent-1', body: 'Local', updatedAt: '2000-01-02T00:00:00.000Z' });

    expect(parentModel.get('parent-1')).toMatchObject({
      preview: 'Local',
      lastChildId: 'child-1',
      updatedAt: '2000-01-02T00:00:00.000Z'
    });
  });

  it('propagates server child writes into existing parent rows', () => {
    installMemoryStorage();
    const parentModel = definePropagationParentModel('propagate-server-parent');
    const childModel = definePropagationChildModel('propagate-server-child', parentModel);

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.applyServerData([{ id: 'child-1', parentId: 'parent-1', body: 'Server', updatedAt: '2000-01-03T00:00:00.000Z' }], { mode: 'merge' });

    expect(parentModel.get('parent-1')).toMatchObject({
      preview: 'Server',
      lastChildId: 'child-1',
      updatedAt: '2000-01-03T00:00:00.000Z'
    });
  });

  it('announces the definitively written row when a state read-back would miss it', () => {
    installMemoryStorage();

    const rawParentCollection = createPersistentCollection<PropagationParentRow>({ id: 'propagate-readback-parent-raw' });
    const rawChildCollection = createPersistentCollection<PropagationChildRow>({ id: 'propagate-readback-child-raw' });

    // On-device (Hermes), a state read-back immediately after insert/update can miss the row still
    // settling inside the open collection transaction. Simulate that by making the raw collection's
    // `get` always miss, regardless of what was just written.
    rawChildCollection.get = () => undefined;

    const parentModel = createCollectionModel<Partial<PropagationParentRow> & { id: string }, PropagationParentRow>({
      collection: rawParentCollection,
      name: 'RelationPropagationParentModel:propagate-readback-parent',
      normalize: input => ({
        id: input.id,
        title: input.title ?? input.id,
        ...(input.preview !== undefined ? { preview: input.preview } : {}),
        ...(input.lastChildId !== undefined ? { lastChildId: input.lastChildId } : {}),
        updatedAt: input.updatedAt ?? null
      }),
      merge: {},
      replace: {}
    });

    const childModel = createCollectionModel<Partial<PropagationChildRow> & { id: string; parentId: string }, PropagationChildRow>({
      collection: rawChildCollection,
      name: 'RelationPropagationChildModel:propagate-readback-child',
      normalize: input => ({
        id: input.id,
        parentId: input.parentId,
        body: input.body ?? input.id,
        updatedAt: input.updatedAt ?? null
      }),
      relations: () => ({
        parent: belongsTo(parentModel, {
          foreignKey: 'parentId',
          propagate: (child: PropagationChildRow) => ({ preview: child.body, lastChildId: child.id, updatedAt: child.updatedAt })
        })
      }),
      merge: {},
      replace: {}
    });

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.applyServerData([{ id: 'child-1', parentId: 'parent-1', body: 'Server', updatedAt: '2000-01-03T00:00:00.000Z' }], { mode: 'merge' });

    expect(parentModel.get('parent-1')).toMatchObject({
      preview: 'Server',
      lastChildId: 'child-1',
      updatedAt: '2000-01-03T00:00:00.000Z'
    });

    // Update path: same read-back-miss simulation, this time patching an existing child.
    parentModel.patch('parent-1', { preview: 'Existing', lastChildId: 'child-0', updatedAt: '2000-01-03T00:00:00.000Z' });
    childModel.applyServerData([{ id: 'child-1', parentId: 'parent-1', body: 'Server Updated', updatedAt: '2000-01-04T00:00:00.000Z' }], { mode: 'merge' });

    expect(parentModel.get('parent-1')).toMatchObject({
      preview: 'Server Updated',
      lastChildId: 'child-1',
      updatedAt: '2000-01-04T00:00:00.000Z'
    });
  });

  it('skips parent propagation when the callback returns null', () => {
    installMemoryStorage();
    const parentModel = definePropagationParentModel('propagate-null-parent');
    const childModel = definePropagationChildModel('propagate-null-child', parentModel, {
      propagate: child => (child.body === 'Older' ? null : { preview: child.body, lastChildId: child.id })
    });

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', preview: 'Existing', lastChildId: 'child-0', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.insertStored({ id: 'child-1', parentId: 'parent-1', body: 'Older', updatedAt: '2000-01-02T00:00:00.000Z' });

    expect(parentModel.get('parent-1')).toMatchObject({
      preview: 'Existing',
      lastChildId: 'child-0',
      updatedAt: '2000-01-01T00:00:00.000Z'
    });
  });

  it('skips parent propagation when the parent row is absent', () => {
    installMemoryStorage();
    const parentModel = definePropagationParentModel('propagate-missing-parent');
    const childModel = definePropagationChildModel('propagate-missing-child', parentModel);

    expect(() => childModel.insertStored({ id: 'child-1', parentId: 'parent-missing', body: 'Missing', updatedAt: null })).not.toThrow();
    expect(parentModel.get('parent-missing')).toBeUndefined();
  });

  it('does not propagate when a child is destroyed', () => {
    installMemoryStorage();
    const parentModel = definePropagationParentModel('propagate-destroy-parent');
    const childModel = definePropagationChildModel('propagate-destroy-child', parentModel);

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', preview: 'Existing', lastChildId: 'child-0', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.applyServerData([{ id: 'child-1', parentId: 'parent-1', body: 'Existing', updatedAt: '2000-01-01T00:00:00.000Z' }], { mode: 'merge' });
    parentModel.patch('parent-1', { preview: 'Existing', lastChildId: 'child-0', updatedAt: '2000-01-01T00:00:00.000Z' });

    expect(childModel.destroy('child-1')).toBe(true);
    expect(parentModel.get('parent-1')).toMatchObject({
      preview: 'Existing',
      lastChildId: 'child-0',
      updatedAt: '2000-01-01T00:00:00.000Z'
    });
  });

  it('keeps propagate and touch independent on local and server child writes', () => {
    installMemoryStorage();
    const parentModel = definePropagationParentModel('propagate-touch-parent');
    const childModel = definePropagationChildModel('propagate-touch-child', parentModel, {
      touch: true,
      propagate: child => ({
        preview: child.body,
        lastChildId: child.id
      })
    });

    parentModel.insertStored({ id: 'parent-local', title: 'Local Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.insertStored({ id: 'child-local', parentId: 'parent-local', body: 'Local', updatedAt: '2000-01-02T00:00:00.000Z' });
    expect(parentModel.get('parent-local')).toMatchObject({
      preview: 'Local',
      lastChildId: 'child-local'
    });
    expect(parentModel.get('parent-local')?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');

    parentModel.insertStored({ id: 'parent-server', title: 'Server Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.applyServerData([{ id: 'child-server', parentId: 'parent-server', body: 'Server', updatedAt: '2000-01-03T00:00:00.000Z' }], { mode: 'merge' });
    expect(parentModel.get('parent-server')).toMatchObject({
      preview: 'Server',
      lastChildId: 'child-server',
      updatedAt: '2000-01-01T00:00:00.000Z'
    });
  });

  it('propagates parent writes produced by child propagation while preventing cycles', () => {
    installMemoryStorage();
    const auditModel = defineMirrorTargetModel('propagate-reentry-audit');
    const parentModel = definePropagationParentModel('propagate-reentry-parent', auditModel);
    const childModel = definePropagationChildModel('propagate-reentry-child', parentModel);

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    auditModel.destroy('parent-1');
    childModel.insertStored({ id: 'child-1', parentId: 'parent-1', body: 'Preview', updatedAt: '2000-01-02T00:00:00.000Z' });

    expect(parentModel.get('parent-1')).toMatchObject({ preview: 'Preview' });
    expect(auditModel.get('parent-1')).toMatchObject({ name: 'Parent' });

    parentModel.patch('parent-1', { title: 'Direct Parent Patch', updatedAt: '2000-01-03T00:00:00.000Z' });
    expect(auditModel.get('parent-1')).toMatchObject({ name: 'Direct Parent Patch' });
  });

  it('propagates server child writes into existing parent rows when the child model sideloads', () => {
    installMemoryStorage();

    type SideloadTargetRow = { id: string; name: string; updatedAt?: string | null };
    const sideloadTargetModel = defineModel<Partial<SideloadTargetRow> & { id: string }, SideloadTargetRow>({
      id: 'propagate-sideload-target',
      name: 'PropagationSideloadTargetModel',
      normalize: input => ({ id: input.id, name: input.name ?? input.id, updatedAt: input.updatedAt ?? null }),
      merge: {},
      replace: {}
    });

    const parentModel = definePropagationParentModel('propagate-sideload-parent');

    type SideloadChildRow = PropagationChildRow;
    type SideloadChildInput = Partial<SideloadChildRow> & { id: string; parentId: string; user?: { id: string; name: string } | null };
    const childModel = defineModel<SideloadChildInput, SideloadChildRow>({
      id: 'propagate-sideload-child',
      name: 'PropagationSideloadChildModel',
      normalize: input => ({
        id: input.id,
        parentId: input.parentId,
        body: input.body ?? input.id,
        updatedAt: input.updatedAt ?? null
      }),
      relations: () => ({
        parent: belongsTo(parentModel, {
          foreignKey: 'parentId',
          propagate: (child: PropagationChildRow) => ({
            preview: child.body,
            lastChildId: child.id,
            updatedAt: child.updatedAt
          })
        })
      }),
      sideload: [{ model: 'PropagationSideloadTargetModel', pluck: (input: SideloadChildInput) => input.user }],
      merge: {},
      replace: {}
    });

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });

    childModel.applyServerData(
      [
        {
          id: 'child-1',
          parentId: 'parent-1',
          body: 'Server',
          updatedAt: '2026-07-09T00:00:00.000Z',
          user: { id: 'user-1', name: 'Ada' }
        }
      ],
      mergeSyncContract('subscription')
    );

    expect(sideloadTargetModel.get('user-1')).toMatchObject({ id: 'user-1', name: 'Ada' });
    expect(childModel.get('child-1')).toMatchObject({ id: 'child-1', body: 'Server' });
    expect(parentModel.get('parent-1')).toMatchObject({
      preview: 'Server',
      lastChildId: 'child-1',
      updatedAt: '2026-07-09T00:00:00.000Z'
    });
  });

  it('variant (a): sideload target itself has a mirror registered', () => {
    installMemoryStorage();

    type SideloadTargetRow = { id: string; name: string; updatedAt?: string | null };
    type MirrorAuditRow = { id: string; name: string; updatedAt?: string | null };
    const auditModel = defineModel<Partial<MirrorAuditRow> & { id: string }, MirrorAuditRow>({
      id: 'propagate-sideload-a-audit',
      name: 'PropagationSideloadAAuditModel',
      normalize: input => ({ id: input.id, name: input.name ?? input.id, updatedAt: input.updatedAt ?? null }),
      merge: {},
      replace: {}
    });
    const sideloadTargetModel = defineModel<Partial<SideloadTargetRow> & { id: string }, SideloadTargetRow>({
      id: 'propagate-sideload-a-target',
      name: 'PropagationSideloadATargetModel',
      normalize: input => ({ id: input.id, name: input.name ?? input.id, updatedAt: input.updatedAt ?? null }),
      mirror: [{ model: () => auditModel, project: (row: SideloadTargetRow) => ({ name: row.name, updatedAt: row.updatedAt }) }],
      merge: {},
      replace: {}
    });

    const parentModel = definePropagationParentModel('propagate-sideload-a-parent');
    type SideloadChildInput = Partial<PropagationChildRow> & { id: string; parentId: string; user?: { id: string; name: string } | null };
    const childModel = defineModel<SideloadChildInput, PropagationChildRow>({
      id: 'propagate-sideload-a-child',
      name: 'PropagationSideloadAChildModel',
      normalize: input => ({ id: input.id, parentId: input.parentId, body: input.body ?? input.id, updatedAt: input.updatedAt ?? null }),
      relations: () => ({
        parent: belongsTo(parentModel, {
          foreignKey: 'parentId',
          propagate: (child: PropagationChildRow) => ({ preview: child.body, lastChildId: child.id, updatedAt: child.updatedAt })
        })
      }),
      sideload: [{ model: 'PropagationSideloadATargetModel', pluck: (input: SideloadChildInput) => input.user }],
      merge: {},
      replace: {}
    });

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.applyServerData(
      [{ id: 'child-1', parentId: 'parent-1', body: 'Server', updatedAt: '2026-07-09T00:00:00.000Z', user: { id: 'user-1', name: 'Ada' } }],
      mergeSyncContract('subscription')
    );

    // eslint-disable-next-line no-console
    console.log('[variant-a]', {
      target: sideloadTargetModel.get('user-1'),
      audit: auditModel.get('user-1'),
      child: childModel.get('child-1'),
      parent: parentModel.get('parent-1')
    });

    expect(parentModel.get('parent-1')).toMatchObject({ preview: 'Server', lastChildId: 'child-1' });
  });

  it('variant (b): two rows in the same applyServerData batch', () => {
    installMemoryStorage();

    type SideloadTargetRow = { id: string; name: string; updatedAt?: string | null };
    const sideloadTargetModel = defineModel<Partial<SideloadTargetRow> & { id: string }, SideloadTargetRow>({
      id: 'propagate-sideload-b-target',
      name: 'PropagationSideloadBTargetModel',
      normalize: input => ({ id: input.id, name: input.name ?? input.id, updatedAt: input.updatedAt ?? null }),
      merge: {},
      replace: {}
    });

    const parentModel = definePropagationParentModel('propagate-sideload-b-parent');
    type SideloadChildInput = Partial<PropagationChildRow> & { id: string; parentId: string; user?: { id: string; name: string } | null };
    const childModel = defineModel<SideloadChildInput, PropagationChildRow>({
      id: 'propagate-sideload-b-child',
      name: 'PropagationSideloadBChildModel',
      normalize: input => ({ id: input.id, parentId: input.parentId, body: input.body ?? input.id, updatedAt: input.updatedAt ?? null }),
      relations: () => ({
        parent: belongsTo(parentModel, {
          foreignKey: 'parentId',
          propagate: (child: PropagationChildRow) => ({ preview: child.body, lastChildId: child.id, updatedAt: child.updatedAt })
        })
      }),
      sideload: [{ model: 'PropagationSideloadBTargetModel', pluck: (input: SideloadChildInput) => input.user }],
      merge: {},
      replace: {}
    });

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.applyServerData(
      [
        { id: 'child-1', parentId: 'parent-1', body: 'First', updatedAt: '2026-07-09T00:00:00.000Z', user: { id: 'user-1', name: 'Ada' } },
        { id: 'child-2', parentId: 'parent-1', body: 'Second', updatedAt: '2026-07-09T00:00:01.000Z', user: { id: 'user-2', name: 'Grace' } }
      ],
      mergeSyncContract('subscription')
    );

    // eslint-disable-next-line no-console
    console.log('[variant-b]', { child1: childModel.get('child-1'), child2: childModel.get('child-2'), parent: parentModel.get('parent-1') });

    expect(parentModel.get('parent-1')).toMatchObject({ preview: 'Second', lastChildId: 'child-2' });
  });

  it('variant (c): child row UPDATE (pre-existing child) instead of insert', () => {
    installMemoryStorage();

    type SideloadTargetRow = { id: string; name: string; updatedAt?: string | null };
    const sideloadTargetModel = defineModel<Partial<SideloadTargetRow> & { id: string }, SideloadTargetRow>({
      id: 'propagate-sideload-c-target',
      name: 'PropagationSideloadCTargetModel',
      normalize: input => ({ id: input.id, name: input.name ?? input.id, updatedAt: input.updatedAt ?? null }),
      merge: {},
      replace: {}
    });

    const parentModel = definePropagationParentModel('propagate-sideload-c-parent');
    type SideloadChildInput = Partial<PropagationChildRow> & { id: string; parentId: string; user?: { id: string; name: string } | null };
    const childModel = defineModel<SideloadChildInput, PropagationChildRow>({
      id: 'propagate-sideload-c-child',
      name: 'PropagationSideloadCChildModel',
      normalize: input => ({ id: input.id, parentId: input.parentId, body: input.body ?? input.id, updatedAt: input.updatedAt ?? null }),
      relations: () => ({
        parent: belongsTo(parentModel, {
          foreignKey: 'parentId',
          propagate: (child: PropagationChildRow) => ({ preview: child.body, lastChildId: child.id, updatedAt: child.updatedAt })
        })
      }),
      sideload: [{ model: 'PropagationSideloadCTargetModel', pluck: (input: SideloadChildInput) => input.user }],
      merge: {},
      replace: {}
    });

    parentModel.insertStored({ id: 'parent-1', title: 'Parent', updatedAt: '2000-01-01T00:00:00.000Z' });
    childModel.insertStored({ id: 'child-1', parentId: 'parent-1', body: 'Original', updatedAt: '2000-01-02T00:00:00.000Z' });

    childModel.applyServerData(
      [{ id: 'child-1', parentId: 'parent-1', body: 'Updated', updatedAt: '2026-07-09T00:00:00.000Z', user: { id: 'user-1', name: 'Ada' } }],
      mergeSyncContract('subscription')
    );

    // eslint-disable-next-line no-console
    console.log('[variant-c]', { child: childModel.get('child-1'), parent: parentModel.get('parent-1') });

    expect(parentModel.get('parent-1')).toMatchObject({ preview: 'Updated', lastChildId: 'child-1' });
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

  it('infers hasOne accessors and row-chain child types', () => {
    installMemoryStorage();
    const messageModel = defineMessageModel('relation-has-one-type-message');
    const chatModel = defineChatModel('relation-has-one-type-chat', () => ({
      lastMessage: hasOne(messageModel, {
        foreignKey: 'chatId',
        comparator: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      })
    }));

    const lastMessage: MessageRow | undefined = chatModel.related.lastMessage.get('chat-1');
    const rowLastMessage: MessageRow | undefined = chatModel.get('chat-1')?.related.lastMessage;
    expect(lastMessage).toBeUndefined();
    expect(rowLastMessage).toBeUndefined();

    if (false) {
      // @ts-expect-error singular hasOne accessors do not expose count
      chatModel.related.lastMessage.count('chat-1');
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
