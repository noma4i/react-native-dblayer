import React, { memo } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

const createChats = (suffix: string) =>
  defineModel({
    id: `SpecChats${suffix}`,
    name: `SpecChats${suffix}`,
    fields: { inboxId: f.str(), title: f.str(), lastActivityAt: f.num(), muted: f.bool() },
    scopes: {
      list: scope<{ id: string; inboxId: string; lastActivityAt: number }>({
        by: { inboxId: 'inboxId' },
        sort: { field: 'lastActivityAt', dir: 'desc' }
      })
    }
  });

const seedChats = (chats: ReturnType<typeof createChats>) =>
  chats.insertMany(
    Array.from({ length: 30 }, (_, index) => ({
      id: `chat-${index}`,
      inboxId: 'main',
      title: `Chat ${index}`,
      lastActivityAt: 30 - index,
      muted: false
    }))
  );

describe('chat list scope sufficiency', () => {
  it('rerenders only the item whose scope row changes', () => {
    setupSpecRuntime();
    const chats = createChats('Item');
    seedChats(chats);
    const renders = new Map<string, number>();
    let root!: TestRenderer.ReactTestRenderer;
    const Item = memo(({ item }: { item: { id: string; title: string } }) => {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return null;
    });
    const List = () => React.createElement(React.Fragment, null, chats.scopes.list.use({ inboxId: 'main' }).map(item => React.createElement(Item, { key: item.id, item })));
    act(() => {
      root = TestRenderer.create(React.createElement(List));
    });
    const before = new Map(renders);
    act(() => chats.update('chat-7', { title: 'Updated title' }));
    expect([...renders].map(([id, count]) => count - (before.get(id) ?? 0))).toEqual([...renders.keys()].map(id => (id === 'chat-7' ? 1 : 0)));
    act(() => root.unmount());
  });

  it('keeps scope output stable for an unrelated model write', () => {
    setupSpecRuntime();
    const chats = createChats('Unrelated');
    const unrelated = defineModel({ id: 'SpecUnrelatedChatScope', name: 'SpecUnrelatedChatScope', fields: { value: f.str() } });
    seedChats(chats);
    unrelated.insert({ id: 'one', value: 'before' });
    const reader = renderCounted(() => chats.scopes.list.use({ inboxId: 'main' }));
    const initial = reader.result();
    const renders = reader.renders();
    act(() => unrelated.update('one', { value: 'after' }));
    expect(reader.result()).toBe(initial);
    expect(reader.renders() - renders).toBe(0);
    reader.unmount();
  });

  it('keeps scope output identity across unrelated-model writes', () => {
    setupSpecRuntime();
    const chats = createChats('Identity');
    const unrelated = defineModel({ id: 'SpecUnrelatedChatScopeIdentity', name: 'SpecUnrelatedChatScopeIdentity', fields: { value: f.str() } });
    seedChats(chats);
    unrelated.insert({ id: 'one', value: 'before' });
    const reader = renderCounted(() => chats.scopes.list.use({ inboxId: 'main' }));
    const initial = reader.result();
    act(() => unrelated.update('one', { value: 'after' }));
    expect(reader.result()).toBe(initial);
    reader.unmount();
  });

  it('gates a scope row by render keys', () => {
    setupSpecRuntime();
    const chats = createChats('Scope');
    seedChats(chats);
    const useScope = chats.scopes.list.use as unknown as (
      value: { inboxId: string },
      options: { renderKeys: readonly string[] }
    ) => Array<{ id: string; title: string }>;
    const reader = renderCounted(() => useScope({ inboxId: 'main' }, { renderKeys: ['id', 'title'] }));
    const initial = reader.result();
    const renders = reader.renders();
    act(() => chats.update('chat-7', { muted: true }));
    expect(reader.renders() - renders).toBe(0);
    expect(reader.result()).toBe(initial);
    reader.unmount();
  });

  it('projects a stable scope window', () => {
    setupSpecRuntime();
    const chats = createChats('Window');
    seedChats(chats);
    const reader = renderCounted(() => chats.scopes.list.useWindow({ inboxId: 'main' }, { pageSize: 5, select: row => ({ id: row.id, title: row.title }) }));
    const initial = reader.result().rows;
    const renders = reader.renders();
    act(() => chats.update('chat-2', { muted: true }));
    expect(reader.renders() - renders).toBe(0);
    expect(reader.result().rows).toBe(initial);
    reader.unmount();
  });
});
