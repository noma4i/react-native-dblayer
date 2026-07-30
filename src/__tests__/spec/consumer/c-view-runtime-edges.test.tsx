import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { belongsTo, configureDb, defineModelRuntime, f, hasOne } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime } from '../helpers/harness';

type ChatRow = {
  id: string;
  inboxId: string;
};

type MessageRow = {
  id: string;
  chatId: string;
  rank: number;
  text: string;
};

const createModels = (suffix: string) => {
  const messages = defineModelRuntime({
    id: `SpecViewRuntimeMessages${suffix}`,
    name: `SpecViewRuntimeMessages${suffix}`,
    fields: { chatId: f.str(), rank: f.num(), text: f.str() }
  });
  const chats = defineModelRuntime({
    id: `SpecViewRuntimeChats${suffix}`,
    name: `SpecViewRuntimeChats${suffix}`,
    fields: { inboxId: f.str() },
    scopes: { inbox: ({ by: { inboxId: 'inboxId' } }) },
    relations: () => ({
      latest: hasOne(messages, {
        foreignKey: 'chatId',
        comparator: (left, right) => right.rank - left.rank
      })
    })
  });
  return { messages, chats };
};

describe('view runtime edges', () => {
  it('maintains a single-relation index across incomplete, moved, and destroyed rows', () => {
    setupSpecRuntime();
    const { messages, chats } = createModels('Index');
    messages.insert({ id: 'incomplete', rank: 99, text: 'ignored' } as never);
    chats.insertMany([
      { id: 'chat-a', inboxId: 'main' },
      { id: 'chat-b', inboxId: 'main' }
    ]);
    const view = chats.view<{ id: string; latest: MessageRow | null }, { latest: MessageRow | null }>('withLatest', {
      source: 'inbox',
      include: { latest: { require: ['text'] } },
      select: (chat, included) => ({ id: chat.id, latest: included.latest })
    });
    const reader = renderCounted(() => view.use({ inboxId: 'main' }));

    expect(reader.result().map(item => item.latest)).toEqual([null, null]);

    act(() => {
      messages.insertMany([
        { id: 'first', chatId: 'chat-a', rank: 1, text: 'first' },
        { id: 'second', chatId: 'chat-a', rank: 2, text: 'second' },
        { id: 'third', chatId: 'chat-a', rank: 0, text: 'third' }
      ]);
    });
    expect(reader.result()[0]?.latest?.id).toBe('second');

    act(() => {
      messages.update('second', { chatId: 'chat-b' });
    });
    expect(reader.result().map(item => item.latest?.id ?? null)).toEqual(['first', 'second']);

    act(() => {
      messages.destroy('first');
      messages.destroy('third');
    });
    expect(reader.result().map(item => item.latest?.id ?? null)).toEqual([null, 'second']);
    reader.unmount();
  });

  it('drops cached source items after scope membership changes and accepts an absent scope value', () => {
    setupSpecRuntime();
    const { messages, chats } = createModels('Membership');
    chats.insertMany([
      { id: 'chat-a', inboxId: 'main' },
      { id: 'chat-b', inboxId: 'main' }
    ]);
    const view = chats.view<ChatRow>('plain', { source: 'inbox', include: {} });
    const nullIncludeView = chats.view<{ id: string; pinned: MessageRow | null }, { pinned: MessageRow | null }>('nullInclude', {
      source: 'inbox',
      include: { pinned: { model: messages, ids: () => null } },
      select: (chat, included) => ({ id: chat.id, pinned: included.pinned })
    });
    const reader = renderCounted(() => view.use({ inboxId: 'main' }));
    const absent = renderCounted(() => view.use(null));
    const nullInclude = renderCounted(() => nullIncludeView.use({ inboxId: 'main' }));

    expect(reader.result().map(row => row.id)).toEqual(['chat-a', 'chat-b']);
    expect(absent.result()).toEqual([]);
    expect(nullInclude.result().map(item => item.pinned)).toEqual([null, null]);

    act(() => {
      chats.update('chat-a', { inboxId: 'archive' });
    });
    expect(reader.result().map(row => row.id)).toEqual(['chat-b']);
    reader.unmount();
    absent.unmount();
    nullInclude.unmount();
  });

  it('maps a non-string parent key to a null relation include', () => {
    setupSpecRuntime();
    const owners = defineModelRuntime({
      id: 'SpecViewRuntimeOwners',
      name: 'SpecViewRuntimeOwners',
      fields: { name: f.str() }
    });
    const records = defineModelRuntime({
      id: 'SpecViewRuntimeOwnedRecords',
      name: 'SpecViewRuntimeOwnedRecords',
      fields: { groupId: f.str(), ownerId: f.str() },
      scopes: { group: ({ by: { groupId: 'groupId' } }) },
      relations: () => ({ owner: belongsTo(owners, { foreignKey: 'ownerId' }) })
    });
    records.insert({ id: 'record', groupId: 'main', ownerId: null } as never);
    const view = records.view<{ id: string; owner: { id: string } | null }, { owner: { id: string } | null }>('withOwner', {
      source: 'group',
      include: { owner: 'owner' },
      select: (record, included) => ({ id: record.id, owner: included.owner })
    });
    const reader = renderCounted(() => view.use({ groupId: 'main' }));

    expect(reader.result()).toEqual([{ id: 'record', owner: null }]);
    reader.unmount();
  });

  it('uses the configured page size, resets on scope changes, and isolates stale page callbacks', () => {
    configureDb({
      storage: createMemoryPlane(),
      transport: createMockTransport(),
      defaults: { pageSize: 2 }
    });
    const { chats } = createModels('Window');
    chats.insertMany([
      { id: 'a-1', inboxId: 'a' },
      { id: 'a-2', inboxId: 'a' },
      { id: 'a-3', inboxId: 'a' },
      { id: 'b-1', inboxId: 'b' },
      { id: 'b-2', inboxId: 'b' },
      { id: 'b-3', inboxId: 'b' }
    ]);
    const view = chats.view<ChatRow>('window', {
      source: 'inbox',
      include: {},
      sort: [{ field: 'id', dir: 'desc' }]
    });
    let result!: ReturnType<typeof view.useWindow>;
    let renders = 0;
    let root!: TestRenderer.ReactTestRenderer;
    const Reader = ({ inboxId }: { inboxId: string }) => {
      result = view.useWindow({ inboxId });
      renders += 1;
      return null;
    };

    act(() => {
      root = TestRenderer.create(React.createElement(Reader, { inboxId: 'a' }));
    });
    const absent = renderCounted(() => view.useWindow(null));
    expect(result.rows.map(row => row.id)).toEqual(['a-3', 'a-2']);
    expect(result.hasMore).toBe(true);
    expect(absent.result().rows).toEqual([]);
    const staleFetchNextPage = result.fetchNextPage;

    act(() => {
      result.fetchNextPage();
    });
    expect({
      rows: result.rows.map(row => row.id),
      totalCount: result.totalCount,
      hasMore: result.hasMore,
      renders
    }).toEqual({
      rows: ['a-3', 'a-2', 'a-1'],
      totalCount: 3,
      hasMore: false,
      renders: 2
    });

    act(() => {
      root.update(React.createElement(Reader, { inboxId: 'b' }));
    });
    expect(result.rows.map(row => row.id)).toEqual(['b-3', 'b-2']);

    act(() => {
      staleFetchNextPage();
    });
    expect(result.rows.map(row => row.id)).toEqual(['b-3', 'b-2']);

    act(() => {
      result.fetchNextPage();
    });
    expect(result.rows.map(row => row.id)).toEqual(['b-3', 'b-2', 'b-1']);
    act(() => root.unmount());
    absent.unmount();
  });
});
