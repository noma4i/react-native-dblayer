import React, { memo } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f, hasOne, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

const createChatModels = (suffix: string) => {
  const messages = defineModel({
    id: `SpecMessages${suffix}`,
    name: `SpecMessages${suffix}`,
    fields: { chatId: f.str(), text: f.str(), sentAt: f.num() }
  });
  const chats = defineModel({
    id: `SpecChats${suffix}`,
    name: `SpecChats${suffix}`,
    fields: { inboxId: f.str(), title: f.str(), lastActivityAt: f.num(), muted: f.bool() },
    scopes: {
      list: scope<{ id: string; inboxId: string; lastActivityAt: number }>({
        by: { inboxId: 'inboxId' },
        sort: { field: 'lastActivityAt', dir: 'desc' }
      })
    },
    relations: () => ({ lastMessage: hasOne(messages, { foreignKey: 'chatId', comparator: (left, right) => right.sentAt - left.sentAt }) })
  });
  return { chats, messages };
};

const seedChats = (models: ReturnType<typeof createChatModels>) => {
  const chats = Array.from({ length: 30 }, (_, index) => ({
    id: `chat-${index}`,
    inboxId: 'main',
    title: `Chat ${index}`,
    lastActivityAt: 30 - index,
    muted: false
  }));
  models.chats.insertStoredMany(chats);
  models.messages.insertStoredMany(
    chats.map((chat, index) => ({ id: `message-${index}`, chatId: chat.id, text: `Preview ${index}`, sentAt: index }))
  );
};

const createChatView = (models: ReturnType<typeof createChatModels>, onSelect?: () => void) =>
  models.chats.view<{ id: string; title: string; preview: string }>('list', {
    source: 'list',
    include: { lastMessage: 'lastMessage' },
    select: (row, included) => {
      onSelect?.();
      return { id: row.id, title: row.title as string, preview: (included.lastMessage as { text: string }).text };
    }
  });

describe('chat list view sufficiency', () => {
  it('rerenders only the item whose chat projection changes', () => {
    setupSpecRuntime();
    const models = createChatModels('Item');
    seedChats(models);
    const view = createChatView(models);
    const renders = new Map<string, number>();
    let root!: TestRenderer.ReactTestRenderer;
    const Item = memo(({ item }: { item: { id: string; title: string; preview: string } }) => {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return null;
    });
    const List = () => React.createElement(React.Fragment, null, view.use({ inboxId: 'main' }).map(item => React.createElement(Item, { key: item.id, item })));
    act(() => {
      root = TestRenderer.create(React.createElement(List));
    });
    const before = new Map(renders);
    act(() => models.chats.patch('chat-7', { title: 'Updated title' }));
    expect([...renders].map(([id, count]) => count - (before.get(id) ?? 0))).toEqual([...renders.keys()].map(id => (id === 'chat-7' ? 1 : 0)));
    act(() => root.unmount());
  });

  it('gates selected view output by render keys while row-level reads keep both options exclusive', () => {
    setupSpecRuntime();
    const models = createChatModels('CombinedProjection');
    seedChats(models);
    const view = models.chats.view<{ id: string; title: string; computed: string }>('combinedProjection', {
      source: 'list',
      include: {},
      select: row => ({ id: row.id, title: row.title as string, computed: row.muted ? 'muted' : 'active' }),
      renderKeys: ['title']
    });
    let itemRenders = 0;
    const Item = memo(({ item }: { item: { id: string; title: string; computed: string } }) => {
      itemRenders += 1;
      return React.createElement('item', { title: item.title, computed: item.computed });
    });
    let root!: TestRenderer.ReactTestRenderer;
    let latestItem!: { id: string; title: string; computed: string };
    const Reader = () => {
      latestItem = view.use({ inboxId: 'main' })[0]!;
      return React.createElement(Item, { item: latestItem });
    };
    act(() => {
      root = TestRenderer.create(React.createElement(Reader));
    });
    const initialItem = latestItem;
    const initialRenders = itemRenders;

    act(() => models.chats.patch('chat-0', { muted: true }));
    expect(latestItem).toBe(initialItem);
    expect(itemRenders - initialRenders).toBe(0);

    act(() => models.chats.patch('chat-0', { title: 'Updated title' }));
    expect(latestItem).not.toBe(initialItem);
    expect(itemRenders - initialRenders).toBe(1);
    act(() => root.unmount());

    const rowOptions = {
      select: (row: { id: string; title: string }) => ({ id: row.id, title: row.title }),
      renderKeys: ['title']
    };
    expect(() => renderCounted(() => models.chats.use.row('chat-0', rowOptions as never))).toThrow('cannot use select and renderKeys together');
  });

  it('does not recompute or rerender for an unrelated included-model row', () => {
    setupSpecRuntime();
    const models = createChatModels('Pinpoint');
    seedChats(models);
    models.messages.insertStored({ id: 'unrelated', chatId: 'outside', text: 'Outside', sentAt: 100 });
    let selects = 0;
    const view = createChatView(models, () => {
      selects += 1;
    });
    const reader = renderCounted(() => view.use({ inboxId: 'main' }));
    const renders = reader.renders();
    const calls = selects;
    act(() => models.messages.patch('unrelated', { text: 'Still outside' }));
    expect(reader.renders() - renders).toBe(0);
    expect(selects - calls).toBe(0);
    reader.unmount();
  });

  it('keeps array identity across unrelated-model writes', () => {
    setupSpecRuntime();
    const models = createChatModels('Identity');
    const unrelated = defineModel({ id: 'SpecUnrelatedChatView', name: 'SpecUnrelatedChatView', fields: { value: f.str() } });
    seedChats(models);
    unrelated.insertStored({ id: 'one', value: 'before' });
    const view = createChatView(models);
    const reader = renderCounted(() => view.use({ inboxId: 'main' }));
    const initial = reader.result();
    act(() => unrelated.patch('one', { value: 'after' }));
    expect(reader.result()).toBe(initial);
    reader.unmount();
  });

  it('gates a scope row by render keys', () => {
    setupSpecRuntime();
    const models = createChatModels('Scope');
    seedChats(models);
    const useScope = models.chats.scopes.list.use as unknown as (
      value: { inboxId: string },
      options: { renderKeys: readonly string[] }
    ) => Array<{ id: string; title: string }>;
    const reader = renderCounted(() => useScope({ inboxId: 'main' }, { renderKeys: ['id', 'title'] }));
    const initial = reader.result();
    const renders = reader.renders();
    act(() => models.chats.patch('chat-7', { muted: true }));
    expect(reader.renders() - renders).toBe(0);
    expect(reader.result()).toBe(initial);
    reader.unmount();
  });

  it('projects a stable scope window', () => {
    setupSpecRuntime();
    const models = createChatModels('Window');
    seedChats(models);
    const reader = renderCounted(() => models.chats.scopes.list.useWindow({ inboxId: 'main' }, { pageSize: 5, select: row => ({ id: row.id, title: row.title }) }));
    const initial = reader.result().rows;
    const renders = reader.renders();
    act(() => models.chats.patch('chat-2', { muted: true }));
    expect(reader.renders() - renders).toBe(0);
    expect(reader.result().rows).toBe(initial);
    reader.unmount();
  });
});
