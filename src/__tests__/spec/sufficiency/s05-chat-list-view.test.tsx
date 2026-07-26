import { act } from 'react-test-renderer';
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
  chats.insertStoredMany(
    Array.from({ length: 30 }, (_, index) => ({
      id: `chat-${index}`,
      inboxId: 'main',
      title: `Chat ${index}`,
      lastActivityAt: 30 - index,
      muted: false
    }))
  );

describe('chat list scope sufficiency', () => {
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
    act(() => chats.patch('chat-7', { muted: true }));
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
    act(() => chats.patch('chat-2', { muted: true }));
    expect(reader.renders() - renders).toBe(0);
    expect(reader.result().rows).toBe(initial);
    reader.unmount();
  });
});
