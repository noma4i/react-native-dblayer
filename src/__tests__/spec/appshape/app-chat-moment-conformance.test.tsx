import { act } from 'react';
import { configureDb } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, renderCountedInProvider, settle, settleUntil } from '../helpers/harness';
import { createAppModels } from './appModels';

const moment = (id: string) => ({ id, uuid: 'moment-uuid-1', userId: 'user-1', createdAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T00:00:00Z', media: { id: 'media-1', kind: 'photo', fileUrl: 'file:///moment.jpg' } });
const document = { kind: 'Document', definitions: [] } as never;
const chat = (id: string, lastActivityAt: string, overrides: Record<string, unknown> = {}) => ({ id, uuid: null, kind: 'group', status: 'active', premium: false, name: 'Group', logoUrl: null, description: null, isPublic: false, history: 'all', pinned: false, muted: false, read: false, unreadCount: 0, messagesCount: 0, lastActivityAt, lastMessageAt: null, lastSequenceNumber: null, lastMessage: null, readMarksSummary: null, summary: null, connectionStatus: null, userIds: [], owner: null, createdAt: lastActivityAt, updatedAt: lastActivityAt, ...overrides });
const message = (id: string, chatId: string) => ({ id, chatId, userId: 'user-1', body: 'existing message', kind: 'text', status: 'Sent', createdAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T00:00:00Z', sequenceNumber: 1, mediaGroupId: null, replyToId: null, media: null, mediaBucket: null, localPreviewUrl: null, clientId: id });

describe('app chat and moment conformance', () => {
  it('CM1 local moment deletion removes every app scope membership and tombstone rejects a stale feed snapshot', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() });
    const models = createAppModels('ChatMomentDelete');
    const row = moment('moment-1');
    models.moments.scopes.feed.seed({}, [row] as any);
    models.moments.scopes.byUser.seed({ userId: 'user-1' }, [row] as any);
    models.moments.scopes.byUuid.seed({ uuid: 'moment-uuid-1' }, [row] as any);
    models.moments.scopes.myMoments.seed({}, [row] as any);
    models.moments.scopes.compassRelations.seed({}, [row] as any);

    models.moments.destroy('moment-1');

    expect(models.moments.find('moment-1')).toBeUndefined();
    expect(models.moments.scopes.feed.read({})).toEqual([]);
    expect(models.moments.scopes.byUser.read({ userId: 'user-1' })).toEqual([]);
    expect(models.moments.scopes.byUuid.read({ uuid: 'moment-uuid-1' })).toEqual([]);
    expect(models.moments.scopes.myMoments.read({})).toEqual([]);
    expect(models.moments.scopes.compassRelations.read({})).toEqual([]);

    models.moments.scopes.feed.seed({}, [row] as any);
    expect(models.moments.find('moment-1')).toBeUndefined();
    expect(models.moments.scopes.feed.read({})).toEqual([]);
  });

  it('CM2 confirmed chat creation keeps list order and related messages through sync and subscription echoes', async () => {
    const created = chat('chat-created', '2026-07-27T00:02:00Z');
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>(operation: any) => ({ data: operation.variables.input.mode === 'sync' ? { chatSync: { chats: [created] } } as TData : { chatGroupCreate: { chat: created } } as TData }) }) });
    const models = createAppModels('ChatCreateConfirm');
    const previous = chat('chat-previous', '2026-07-27T00:01:00Z');
    models.chats.scopes.list.seed({ statusFilter: 'active' }, [previous] as any);
    models.messages.scopes.thread.seed({ chatId: 'chat-created' }, [message('message-existing', 'chat-created')] as any);
    const create = models.chats.mutation('createGroup', { document, result: 'chatGroupCreate', extract: ({ data }: any) => [{ into: models.chats, rows: [data.chatGroupCreate.chat] }] });

    await act(async () => { await create.run({ mode: 'create' } as any); });

    expect(models.chats.scopes.list.read({ statusFilter: 'active' }).map((row: any) => row.id)).toEqual(['chat-created', 'chat-previous']);
    expect(models.messages.scopes.thread.read({ chatId: 'chat-created' }).map((row: any) => row.id)).toEqual(['message-existing']);

    const sync = models.chats.mutation('sync', { document, result: 'chatSync', extract: ({ data }: any) => [{ into: models.chats, rows: data.chatSync.chats }] });
    const ingest = models.chats.ingest({ chatCreated: { handler: (payload: any) => ({ upsert: payload.chat, invalidate: { statusFilter: payload.chat.status } }) } });
    await act(async () => { await sync.run({ mode: 'sync' } as any); });
    act(() => { ingest.apply('chatCreated', { chat: created }); });

    expect(models.chats.all().filter((row: any) => row.id === 'chat-created')).toHaveLength(1);
    expect(models.chats.scopes.list.read({ statusFilter: 'active' }).map((row: any) => row.id)).toEqual(['chat-created', 'chat-previous']);
  });

  it('CM3 chat creation network rejection leaves the loaded list and message membership unchanged', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async () => { throw new Error('offline'); } }) });
    const models = createAppModels('ChatCreateNetworkFailure');
    const existing = chat('chat-existing', '2026-07-27T00:01:00Z');
    models.chats.scopes.list.seed({ statusFilter: 'active' }, [existing] as any);
    models.messages.scopes.thread.seed({ chatId: 'chat-existing' }, [message('message-existing', 'chat-existing')] as any);
    const create = models.chats.mutation('createGroup', { document, result: 'chatGroupCreate', extract: ({ data }: any) => [{ into: models.chats, rows: [data.chatGroupCreate.chat] }] });

    await expect(create.run({})).rejects.toThrow('offline');

    expect(models.chats.scopes.list.read({ statusFilter: 'active' }).map((row: any) => row.id)).toEqual(['chat-existing']);
    expect(models.messages.scopes.thread.read({ chatId: 'chat-existing' }).map((row: any) => row.id)).toEqual(['message-existing']);
  });

  it('CM4 chat creation server rejection leaves the loaded list and message membership unchanged', async () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ mutation: async <TData,>() => ({ data: { chatGroupCreate: null } as TData }) }) });
    const models = createAppModels('ChatCreateServerFailure');
    const existing = chat('chat-existing', '2026-07-27T00:01:00Z');
    models.chats.scopes.list.seed({ statusFilter: 'active' }, [existing] as any);
    models.messages.scopes.thread.seed({ chatId: 'chat-existing' }, [message('message-existing', 'chat-existing')] as any);
    const create = models.chats.mutation('createGroup', { document, result: 'chatGroupCreate', extract: ({ data }: any) => data.chatGroupCreate?.chat ? [{ into: models.chats, rows: [data.chatGroupCreate.chat] }] : [] });

    await expect(create.run({})).rejects.toThrow('chatGroupCreate returned no data');

    expect(models.chats.scopes.list.read({ statusFilter: 'active' }).map((row: any) => row.id)).toEqual(['chat-existing']);
    expect(models.messages.scopes.thread.read({ chatId: 'chat-existing' }).map((row: any) => row.id)).toEqual(['message-existing']);
  });

  it('CM5 feed pages retain server order, deduplicate overlap, preserve row identity, and survive screen re-entry', async () => {
    const first = { feed: { nodes: [moment('moment-3'), moment('moment-2')], pageInfo: { hasNextPage: true, endCursor: 'cursor-2' }, lastSequenceNumber: 2 } };
    const second = { feed: { nodes: [moment('moment-2'), moment('moment-1')], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 1 } };
    const responses = [first, second, first];
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ query: async <TData,>() => ({ data: responses.shift() as TData }) }) });
    const models = createAppModels('MomentFeedPages');
    const feedQuery = models.moments.query<any, { afterSequence?: number }, {}, any>('feed', { document, vars: () => ({}), page: data => data.feed, into: models.moments.scopes.feed, coverage: 'page', getCursor: (page: any) => String(page.lastSequenceNumber), cursorVar: 'afterSequence', mapCursor: Number });
    const feedReader = renderCounted(() => models.moments.scopes.feed.use({}));
    const queryReader = renderCountedInProvider(() => feedQuery.use({}));

    await settle();
    await settle(1, { macro: true });
    const firstRow = models.moments.find('moment-2');
    expect(feedReader.result().map((row: any) => row.id)).toEqual(['moment-3', 'moment-2']);

    act(() => { queryReader.result().fetchNextPage(); });
    await settle();
    await settle(1, { macro: true });
    expect(feedReader.result().map((row: any) => row.id)).toEqual(['moment-3', 'moment-2', 'moment-1']);
    expect(models.moments.find('moment-2')).toBe(firstRow);

    await act(async () => { await queryReader.result().refetch(); });
    expect(feedReader.result().map((row: any) => row.id)).toEqual(['moment-3', 'moment-2', 'moment-1']);
    expect(models.moments.find('moment-2')).toBe(firstRow);

    feedReader.unmount();
    queryReader.unmount();
  });

  it('CM6 single and external-key channels preserve one feed row and its membership', async () => {
    const row = { ...moment('moment-1'), uuid: 'moment-public-1' };
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ query: async <TData,>() => ({ data: { moment: row, publicMoment: row } as TData }) }) });
    const models = createAppModels('MomentOtherChannels');
    const bootReader = renderCountedInProvider(() => null);
    await settle();
    models.moments.scopes.feed.seed({}, [row] as any);
    const feedRow = models.moments.find('moment-1');
    const singleQuery = models.moments.query<any, { momentId: string }, { momentId: string }, any>('singleMoment', { document, vars: scope => scope, select: data => data.moment, into: models.moments });
    const byUuidQuery = models.moments.query<any, { uuid: string }, { uuid: string }, any>('momentByUuid', { document, vars: scope => scope, select: data => data.publicMoment, into: models.moments });
    const singleReader = renderCountedInProvider(() => singleQuery.useRowEnsured({ momentId: 'moment-1' }, 'moment-1'));
    await settle();
    await settle(1, { macro: true });
    const uuidReader = renderCountedInProvider(() => byUuidQuery.use({ uuid: 'moment-public-1' }));
    await settle();
    await settle(1, { macro: true });

    expect(models.moments.all().filter((item: any) => item.id === 'moment-1')).toHaveLength(1);
    expect(singleReader.result().data).toBe(feedRow);
    expect(models.moments.find('moment-1')).toBe(feedRow);
    expect(models.moments.scopes.feed.read({}).map((item: any) => item.id)).toEqual(['moment-1']);

    bootReader.unmount();
    singleReader.unmount();
    uuidReader.unmount();
  });

  it('CM7 feed network rejection preserves the already loaded scope', async () => {
    const row = moment('moment-1');
    let calls = 0;
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ query: async <TData,>() => {
      calls += 1;
      if (calls === 1) return { data: { feed: { nodes: [row], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 1 } } as TData };
      throw new Error('network offline');
    } }) });
    const models = createAppModels('MomentFeedNetworkFailure');
    const feedQuery = models.moments.query<any, {}, {}, any>('feed', { document, vars: () => ({}), page: data => data.feed, into: models.moments.scopes.feed, coverage: 'page' });
    const queryReader = renderCountedInProvider(() => feedQuery.use({}));

    await settle();
    await settle(1, { macro: true });
    await settleUntil(() => models.moments.scopes.feed.read({}).length === 1, 20, { macro: true });
    await act(async () => { await queryReader.result().refetch(); });
    await settle();
    await settle(1, { macro: true });

    expect(models.moments.scopes.feed.read({}).map((item: any) => item.id)).toEqual(['moment-1']);
    expect(queryReader.result().error?.message).toBe('network offline');
    queryReader.unmount();
  });

  it('CM8 feed server rejection preserves the already loaded scope', async () => {
    const row = moment('moment-1');
    let calls = 0;
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({ query: async <TData,>() => {
      calls += 1;
      if (calls === 1) return { data: { feed: { nodes: [row], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 1 } } as TData };
      throw new Error('server denied');
    } }) });
    const models = createAppModels('MomentFeedServerFailure');
    const feedQuery = models.moments.query<any, {}, {}, any>('feed', { document, vars: () => ({}), page: data => data.feed, into: models.moments.scopes.feed, coverage: 'page' });
    const queryReader = renderCountedInProvider(() => feedQuery.use({}));

    await settle();
    await settle(1, { macro: true });
    await settleUntil(() => models.moments.scopes.feed.read({}).length === 1, 20, { macro: true });
    await act(async () => { await queryReader.result().refetch(); });
    await settle();
    await settle(1, { macro: true });

    expect(models.moments.scopes.feed.read({}).map((item: any) => item.id)).toEqual(['moment-1']);
    expect(queryReader.result().error?.message).toBe('server denied');
    queryReader.unmount();
  });
});
