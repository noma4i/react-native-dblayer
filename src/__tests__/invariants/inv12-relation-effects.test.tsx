import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { expandPlan, belongsTo, hasMany, hasOne } from '../../core/relations';
import { getApplyRuntime, configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { f } from '../../schema/f';
import type { StoragePlane } from '../../core/planes/storagePlane';

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const renderRead = <T,>(read: () => T) => {
  let value: T;
  let forceRender: (() => void) | null = null;
  const renders = jest.fn();
  const Reader = () => {
    const [, setVersion] = React.useState(0);
    forceRender = () => setVersion(version => version + 1);
    value = read();
    renders();
    return null;
  };
  act(() => { TestRenderer.create(<Reader />); });
  return { value: () => value!, renders, forceRender: () => act(() => forceRender!()) };
};

const setup = () => {
  configureDb({ storage: createStorage(), transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any });
  let chats: any;
  let messages: any;
  let reactions: any;
  chats = defineModel({
    id: 'chats',
    name: 'chats',
    fields: { unreadCount: f.num(), lastText: f.str(), lastActivityAt: f.num() },
    relations: () => ({
      messages: hasMany(messages, { foreignKey: 'chatId', dependent: 'destroy' }),
      lastMessage: hasOne(messages, { foreignKey: 'chatId', comparator: (left: any, right: any) => Number(right.createdAt) - Number(left.createdAt) })
    })
  });
  messages = defineModel({
    id: 'messages',
    name: 'messages',
    fields: { chatId: f.str(), text: f.str(), kind: f.str(), createdAt: f.num() },
    relations: () => ({
      chat: belongsTo(chats, {
        foreignKey: 'chatId',
        touch: (message: any, chat: any) => ({ lastText: message.text, lastActivityAt: Math.max(Number(chat.lastActivityAt ?? 0), Number(message.createdAt)) }),
        counterCache: { field: 'unreadCount', filter: (message: any) => message.kind !== 'system' }
      }),
      reactions: hasMany(reactions, { foreignKey: 'messageId', dependent: 'destroy' })
    })
  });
  reactions = defineModel({ id: 'reactions', name: 'reactions', fields: { messageId: f.str() } });
  const chat = (id = 'chat-1', overrides: Record<string, unknown> = {}) => ({ id, unreadCount: 0, lastText: '', lastActivityAt: 0, ...overrides });
  const message = (id = 'message-1', overrides: Record<string, unknown> = {}) => ({ id, chatId: 'chat-1', text: 'text', kind: 'user', createdAt: 1, ...overrides });
  return { chats, messages, reactions, chat, message };
};

describe('v6 invariant 12: relation effects', () => {
  it('increments a counter only for a first-seen counted message', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message());
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
    messages.insertStored(message());
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
  });

  it('touches a parent on a message patch without changing the counter', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message('message-1', { text: 'before' }));
    messages.patch('message-1', { text: 'after' });
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
    expect(chats.get('chat-1')?.lastText).toBe('after');
  });

  it('does not count system messages in either direction', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message('system-1', { kind: 'system' }));
    expect(chats.get('chat-1')?.unreadCount).toBe(0);
    messages.destroy('system-1');
    expect(chats.get('chat-1')?.unreadCount).toBe(0);
  });

  it('decrements a counter when a counted message is destroyed', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message());
    messages.destroy('message-1');
    expect(chats.get('chat-1')?.unreadCount).toBe(0);
  });

  it('keeps the counter stable across a temporary-to-server replacement', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message('temp-1'));
    messages.replaceRaw('temp-1', message('server-1'));
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
  });

  it('uses touch values from message data', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message('message-1', { text: 'fresh', createdAt: 7 }));
    expect(chats.get('chat-1')?.lastText).toBe('fresh');
    expect(chats.get('chat-1')?.lastActivityAt).toBe(7);
  });

  it('folds multiple touches into one parent patch with the maximum activity', () => {
    const { chats, chat, message } = setup();
    chats.insertStored(chat());
    const expanded = expandPlan([{ kind: 'upsert', model: 'messages', rows: [message('a', { createdAt: 5 }), message('b', { createdAt: 3 })] }]);
    const patches = expanded.filter((op): op is Extract<typeof op, { kind: 'patch' }> => op.kind === 'patch' && op.model === 'chats');
    expect(patches).toHaveLength(1);
    expect(patches[0].patch.lastActivityAt).toBe(5);
  });

  it('does not derive effects against an authoritative parent upsert', () => {
    const { chat, message } = setup();
    const expanded = expandPlan([{ kind: 'upsert', model: 'chats', rows: [chat()] }, { kind: 'upsert', model: 'messages', rows: [message()] }]);
    expect(expanded.some(op => op.kind === 'counter' && op.model === 'chats')).toBe(false);
    expect(expanded.some(op => op.kind === 'patch' && op.model === 'chats')).toBe(false);
  });

  it('ignores relation effects for a missing parent', () => {
    const { messages, message } = setup();
    expect(() => messages.insertStored(message())).not.toThrow();
    const expanded = expandPlan([{ kind: 'upsert', model: 'messages', rows: [message()] }]);
    expect(expanded.some(op => op.kind === 'patch' && op.model === 'chats')).toBe(false);
  });

  it('cascades explicit chat destroy through messages and reactions', () => {
    const { chats, messages, reactions, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message());
    reactions.insertStored({ id: 'reaction-1', messageId: 'message-1' });
    chats.destroy('chat-1');
    expect(chats.get('chat-1')).toBeUndefined();
    expect(messages.get('message-1')).toBeUndefined();
    expect(reactions.get('reaction-1')).toBeUndefined();
  });

  it('does not run relation effects for snapshot writes', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.__applyRows?.([
      message('message-1', { text: 'snapshot-1', createdAt: 9 }),
      message('message-2', { text: 'snapshot-2', createdAt: 8 }),
      message('message-3', { text: 'snapshot-3', createdAt: 7 })
    ]);
    expect(chats.get('chat-1')?.unreadCount).toBe(0);
    expect(chats.get('chat-1')?.lastText).toBe('');
  });

  it('reads relations with pinpoint updates and stable unrelated arrays', () => {
    const { chats, messages, reactions, chat, message } = setup();
    chats.insertStored(chat('chat-1'));
    chats.insertStored(chat('chat-2'));
    messages.insertStored(message('message-1', { createdAt: 1 }));
    const parent = renderRead(() => messages.use.related('message-1', 'chat'));
    expect(parent.value()?.id).toBe('chat-1');
    act(() => chats.patch('chat-2', { lastText: 'other' }));
    expect(parent.renders).toHaveBeenCalledTimes(1);
    act(() => chats.patch('chat-1', { lastText: 'updated' }));
    expect(parent.renders).toHaveBeenCalledTimes(2);
    const last = renderRead(() => chats.use.related('chat-1', 'lastMessage'));
    expect(last.value()?.id).toBe('message-1');
    act(() => messages.insertStored(message('message-2', { createdAt: 2 })));
    expect(last.value()?.id).toBe('message-2');
    reactions.insertStored({ id: 'reaction-1', messageId: 'message-1' });
    const all = renderRead(() => chats.use.related('chat-1', 'messages'));
    const before = all.value();
    act(() => reactions.patch('reaction-1', { messageId: 'message-2' }));
    all.forceRender();
    expect(all.value()).toBe(before);
  });

  it('applies a message and its relation effects in one epoch', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    const runtime = getApplyRuntime();
    const before = runtime.currentEpoch();
    messages.insertStored(message());
    expect(runtime.currentEpoch()).toBe(before + 1);
  });
});
