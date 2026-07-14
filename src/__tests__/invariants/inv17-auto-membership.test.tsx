import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { buildScopeKey } from '../../core/compileDbWhere';
import { belongsTo, hasMany } from '../../core/relations';
import { getApplyRuntime, configureDb } from '../../dsl/configure';
import { defineIngest } from '../../dsl/defineIngest';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import type { StoragePlane } from '../../core/planes/storagePlane';

type Message = { id: string; chatId: string; text: string; kind: string; createdAt: number };

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => {
      for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value);
    },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const renderRead = <T,>(read: () => T) => {
  let value!: T;
  const renders = jest.fn();
  let root!: TestRenderer.ReactTestRenderer;
  const Reader = () => {
    value = read();
    renders();
    return null;
  };
  act(() => {
    root = TestRenderer.create(<Reader />);
  });
  return { value: () => value, renders, unmount: () => act(() => root.unmount()) };
};

const setup = () => {
  const storage = createStorage();
  configureDb({
    storage,
    transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any
  });
  let chats: any;
  let messages: any;
  chats = defineModel({
    id: 'auto-membership-chats',
    name: 'AutoMembershipChatModel',
    fields: { unreadCount: f.num(), lastText: f.str(), lastActivityAt: f.num() },
    relations: () => ({ messages: hasMany(messages, { foreignKey: 'chatId', dependent: 'destroy' }) })
  });
  messages = defineModel({
    id: 'auto-membership-messages',
    name: 'AutoMembershipMessageModel',
    fields: { chatId: f.str(), text: f.str(), kind: f.str(), createdAt: f.num() },
    scopes: { thread: scope({ by: { chatId: 'chatId' }, sort: { field: 'createdAt', dir: 'asc' } }) },
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
  const chat = (id: string) => ({ id, unreadCount: 0, lastText: '', lastActivityAt: 0 });
  const message = (id: string, overrides: Partial<Message> = {}): Message => ({
    id,
    chatId: 'c1',
    text: id,
    kind: 'user',
    createdAt: 1,
    ...overrides
  });
  return { storage, chats, messages, chat, message };
};

const journalRecords = (storage: StoragePlane) =>
  storage.keys('dbl:journal:')
    .map(key => JSON.parse(storage.get(key)!) as { epoch: number; ops: Array<{ kind: string; model: string }> })
    .sort((left, right) => left.epoch - right.epoch);

describe('v6 invariant 17: automatic scope membership', () => {
  it('A. makes inserted messages visible in their thread in the same tick', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    const view = renderRead(() => messages.scopes.thread.use({ chatId: 'c1' }));

    act(() => {
      messages.insertStored(message('message-1'));
      expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([message('message-1')]);
    });

    expect(view.value()).toEqual([message('message-1')]);
    expect(view.renders).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('B. applies ingest membership and relation effects in one epoch', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    const ingest = defineIngest(messages, { received: () => ({ upsert: message('message-1', { text: 'ingested', createdAt: 2 }) }) });
    const before = getApplyRuntime().currentEpoch();

    ingest.apply('received', {});

    expect(getApplyRuntime().currentEpoch()).toBe(before + 1);
    expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([message('message-1', { text: 'ingested', createdAt: 2 })]);
    expect(chats.get('c1')).toMatchObject({ unreadCount: 1, lastText: 'ingested', lastActivityAt: 2 });
  });

  it('C. journals membership scope operations with event upserts', () => {
    const { storage, chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));

    messages.insertStored(message('message-1'));

    const record = journalRecords(storage).at(-1)!;
    expect(record.ops.some(op => op.kind === 'upsert' && op.model === 'auto-membership-messages')).toBe(true);
    expect(record.ops.some(op => op.kind === 'scope' && op.model === 'auto-membership-messages')).toBe(true);
  });

  it('D. replaces a temporary row with one scope rerender', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    messages.insertStored(message('temp-1', { text: 'temporary' }));
    const view = renderRead(() => messages.scopes.thread.use({ chatId: 'c1' }));

    act(() => {
      messages.replaceRaw('temp-1', message('server-1', { text: 'server' }));
    });

    expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([message('server-1', { text: 'server' })]);
    expect(view.renders).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('E. moves a patched row between thread memberships', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    chats.insertStored(chat('c2'));
    messages.insertStored(message('message-1'));

    messages.patch('message-1', { chatId: 'c2' });

    expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([]);
    expect(messages.scopes.thread.read({ chatId: 'c2' })).toEqual([message('message-1', { chatId: 'c2' })]);
  });

  it('F. detaches destroyed rows from the persisted thread index', () => {
    const { storage, chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    messages.insertStored(message('message-1'));

    messages.destroy('message-1');

    expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([]);
    const scopeValue = JSON.parse(storage.get(`dbl:scope:auto-membership-messages:${buildScopeKey({ chatId: 'c1' })}`)!);
    expect(scopeValue.entries).toEqual([]);
  });

  it('G. detaches thread entries during dependent cascade destroy', () => {
    const { storage, chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    messages.insertStored(message('message-1'));

    chats.destroy('c1');

    expect(messages.get('message-1')).toBeUndefined();
    const scopeValue = JSON.parse(storage.get(`dbl:scope:auto-membership-messages:${buildScopeKey({ chatId: 'c1' })}`)!);
    expect(scopeValue.entries).toEqual([]);
  });

  it('H. lets complete snapshots detach auto-added rows before later event re-addition', () => {
    const { chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    const row = message('message-1');
    messages.insertStored(row);
    expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([row]);

    messages.scopes.thread.__apply?.({ chatId: 'c1' }, [], 'complete');
    expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([]);

    messages.insertStored(row);
    expect(messages.scopes.thread.read({ chatId: 'c1' })).toEqual([row]);
  });

  it('I. omits scope ops and rerenders for idempotent event upserts', () => {
    const { storage, chats, messages, chat, message } = setup();
    chats.insertStored(chat('c1'));
    const row = message('message-1');
    messages.insertStored(row);
    const view = renderRead(() => messages.scopes.thread.use({ chatId: 'c1' }));

    messages.insertStored(row);

    const record = journalRecords(storage).at(-1)!;
    expect(record.ops.some(op => op.kind === 'scope' && op.model === 'auto-membership-messages')).toBe(false);
    expect(view.renders).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
