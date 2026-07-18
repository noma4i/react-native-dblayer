import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { belongsTo } from '../../core/relations';
import { getApplyRuntime, getOperationState, configureDb } from '../../dsl/configure';
// Public ingest construction uses Model.ingest; these invariants cover engine return values.
import { defineIngest } from '../../dsl/defineIngest';
import { defineModel } from '../../dsl/defineModel';
import { f } from '../../schema/f';
import type { StoragePlane } from '../../core/planes/storagePlane';

type Message = { id: string; chatId: string; text: string; kind: string; createdAt: number };

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
  const renders = jest.fn();
  const Reader = () => {
    value = read();
    renders();
    return null;
  };
  act(() => { TestRenderer.create(<Reader />); });
  return { value: () => value!, renders };
};

const setup = () => {
  configureDb({
    storage: createStorage(),
    transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any
  });
  let chats: any;
  let messages: any;
  chats = defineModel({
    id: 'chats',
    name: 'chats',
    fields: { unreadCount: f.num(), lastText: f.str(), lastActivityAt: f.num() }
  });
  messages = defineModel({
    id: 'messages',
    name: 'messages',
    fields: { chatId: f.str(), text: f.str(), kind: f.str(), createdAt: f.num() },
    relations: () => ({
      chat: belongsTo(chats, {
        foreignKey: 'chatId',
        touch: (message: Message, chat: { lastActivityAt?: number }) => ({
          lastText: message.text,
          lastActivityAt: Math.max(Number(chat.lastActivityAt ?? 0), message.createdAt)
        }),
        counterCache: { field: 'unreadCount' as any, filter: (message: Message) => message.kind !== 'system' }
      })
    })
  });
  const chat = (overrides: Record<string, unknown> = {}) => ({ id: 'chat-1', unreadCount: 0, lastText: '', lastActivityAt: 0, ...overrides });
  const message = (id: string, overrides: Partial<Message> = {}): Message => ({
    id,
    chatId: 'chat-1',
    text: id,
    kind: 'user',
    createdAt: 1,
    ...overrides
  });
  return { chats, messages, chat, message };
};

describe('v6 invariant 15: ingest events', () => {
  it('applies one event declaration and relation effects in one epoch', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    messages.insertStored(message('old-message', { text: 'old', createdAt: 1 }));
    const ingest = messages.ingest({
      received: { handler: () => ({
        upsert: [message('message-1', { text: 'first', createdAt: 2 }), message('message-2', { text: 'second', createdAt: 3 })],
        destroy: ['old-message']
      }) }
    });
    const before = getApplyRuntime().currentEpoch();
    ingest.apply('received', {});
    expect(getApplyRuntime().currentEpoch()).toBe(before + 1);
    expect(messages.get('old-message')).toBeUndefined();
    expect(messages.get('message-1')?.text).toBe('first');
    expect(messages.get('message-2')?.text).toBe('second');
    expect(chats.get('chat-1')).toMatchObject({ unreadCount: 2, lastText: 'second', lastActivityAt: 3 });
  });

  it('is idempotent for repeated delivery and does not notify unchanged chat reads', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    const declaration = { upsert: message('message-1', { text: 'once', createdAt: 2 }) };
    const ingest = messages.ingest({ received: { handler: () => declaration } });
    ingest.apply('received', {});
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
    const view = renderRead(() => chats.use.row('chat-1'));
    expect(view.renders).toHaveBeenCalledTimes(1);
    ingest.apply('received', {});
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
    expect(view.renders).toHaveBeenCalledTimes(1);
  });

  it('skips a committed local echo while returning its declaration', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    const key = 'echo-committed';
    getOperationState().begin({
      operationId: 'operation-1',
      model: 'messages',
      tempIds: [],
      intent: 'insert',
      idempotencyKey: key,
      createdAt: 1
    });
    getOperationState().close('operation-1', 'committed');
    const declaration = { operationId: key, upsert: message('echo-row', { text: 'echo', createdAt: 2 }) };
    const ingest = defineIngest(messages, { received: () => declaration });
    const before = getApplyRuntime().currentEpoch();
    expect(ingest.apply('received', {})).toBe(declaration);
    expect(getApplyRuntime().currentEpoch()).toBe(before);
    expect(messages.get('echo-row')).toBeUndefined();
    expect(chats.get('chat-1')?.unreadCount).toBe(0);
  });

  it('applies an event whose operation id is not committed', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    const ingest = messages.ingest({
      received: { handler: () => ({ operationId: 'missing-operation', upsert: message('normal-row', { text: 'normal', createdAt: 2 }) }) }
    });
    ingest.apply('received', {});
    expect(messages.get('normal-row')?.text).toBe('normal');
    expect(chats.get('chat-1')?.unreadCount).toBe(1);
  });

  it('returns null for an unknown event without applying an epoch', () => {
    const { messages } = setup();
    const ingest = defineIngest(messages, {});
    const before = getApplyRuntime().currentEpoch();
    expect(ingest.apply('unknown', {})).toBeNull();
    expect(getApplyRuntime().currentEpoch()).toBe(before);
  });

  it('invalidates the model when the declaration requests it', () => {
    const { messages } = setup();
    const invalidate = jest.spyOn(messages, 'invalidate');
    const ingest = messages.ingest({ received: { handler: () => ({ invalidate: true }) } });
    ingest.apply('received', {});
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('applies extracted authoritative chat rows in the same event epoch', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    const ingest = messages.ingest({
      received: { handler: () => ({
        upsert: message('message-1', { text: 'message touch', createdAt: 2 }),
        extract: [{ into: chats, rows: [{ id: 'chat-1', unreadCount: 40, lastText: 'authoritative', lastActivityAt: 99 }] }]
      }) }
    });
    const before = getApplyRuntime().currentEpoch();
    ingest.apply('received', {});
    expect(getApplyRuntime().currentEpoch()).toBe(before + 1);
    expect(chats.get('chat-1')).toMatchObject({ unreadCount: 40, lastText: 'authoritative', lastActivityAt: 99 });
  });
});
