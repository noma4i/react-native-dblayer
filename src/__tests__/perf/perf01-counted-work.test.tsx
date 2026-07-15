import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { belongsTo, hasMany } from '../../core/relations';
import { configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createCountingStorage, journalRecordCount, trackNotifies } from './perfHarness';

type Message = { id: string; chatId: string; text: string; kind: string; createdAt: number };

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
  const storage = createCountingStorage();
  configureDb({
    storage: storage.plane,
    transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any
  });
  let chats: any;
  let messages: any;
  chats = defineModel({
    id: 'perf-counted-chats',
    name: 'PerfCountedChatModel',
    fields: { unreadCount: f.num(), lastText: f.str(), lastActivityAt: f.num() },
    relations: () => ({ messages: hasMany(messages, { foreignKey: 'chatId', dependent: 'destroy' }) })
  });
  messages = defineModel({
    id: 'perf-counted-messages',
    name: 'PerfCountedMessageModel',
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
  const chat = (id = 'c1') => ({ id, unreadCount: 0, lastText: '', lastActivityAt: 0 });
  const message = (id: string, overrides: Partial<Message> = {}): Message => ({
    id,
    chatId: 'c1',
    text: id,
    kind: 'user',
    createdAt: 1,
    ...overrides
  });
  return { ...storage, chats, messages, chat, message };
};

describe('perf 01: counted work', () => {
  it('A. persists and notifies once for one event plan', () => {
    const { plane, counters, resetCounters, chats, messages, chat, message } = setup();
    chats.insertStored(chat());
    const tracker = trackNotifies([{ kind: 'model', model: 'perf-counted-messages' }]);
    const beforeJournal = journalRecordCount(plane);
    resetCounters();

    messages.insertStored(message('message-1'));

    // WAL: exactly two journal-only batches per plan - pending first, then committed.
    expect(counters.setBatches).toBe(2);
    expect(journalRecordCount(plane)).toBe(beforeJournal + 1);
    expect(plane.keys('dbl:row:')).toHaveLength(0);
    expect(plane.keys('dbl:scope:')).toHaveLength(0);
    expect(tracker.count()).toBe(1);
    tracker.unsubscribe();
  });

  it('B. persists a 20-row scope page in one batch and journal record', () => {
    const { plane, counters, resetCounters, messages, message } = setup();
    const rows = Array.from({ length: 20 }, (_, index) => message(`message-${index}`, { createdAt: index }));
    const beforeJournal = journalRecordCount(plane);
    resetCounters();

    messages.scopes.thread.__apply?.({ chatId: 'c1' }, rows, 'page');

    // WAL: exactly two journal-only batches per plan - pending first, then committed.
    expect(counters.setBatches).toBe(2);
    expect(journalRecordCount(plane)).toBe(beforeJournal + 1);
    expect(plane.keys('dbl:row:')).toHaveLength(0);
    expect(plane.keys('dbl:scope:')).toHaveLength(0);
  });

  it('C. does not notify a row reader or row dependency for an idempotent repeat', () => {
    const { messages, message } = setup();
    const row = message('message-1');
    messages.insertStored(row);
    const view = renderRead(() => messages.use.row('message-1'));
    const tracker = trackNotifies([{ kind: 'row', model: 'perf-counted-messages', id: 'message-1' }]);

    act(() => {
      messages.insertStored(row);
    });

    expect(tracker.count()).toBe(0);
    expect(view.renders).toHaveBeenCalledTimes(1);
    tracker.unsubscribe();
    view.unmount();
  });

  it('D. notifies exactly one unfiltered row dependency among fifty', () => {
    const { messages, message } = setup();
    const rows = Array.from({ length: 50 }, (_, index) => message(`message-${index}`, { createdAt: index }));
    for (const row of rows) messages.insertStored(row);
    const trackers = rows.map(row => trackNotifies([{ kind: 'row', model: 'perf-counted-messages', id: row.id }]));

    messages.patch('message-17', { text: 'patched' });

    expect(trackers[17].count()).toBe(1);
    expect(trackers.filter((_, index) => index !== 17).every(tracker => tracker.count() === 0)).toBe(true);
    for (const tracker of trackers) tracker.unsubscribe();
  });

  it('E. rerenders only the matching field reader', () => {
    const { messages, message } = setup();
    messages.insertStored(message('message-1'));
    const text = renderRead(() => messages.use.field('message-1', 'text'));
    const kind = renderRead(() => messages.use.field('message-1', 'kind'));

    act(() => {
      messages.patch('message-1', { text: 'patched' });
    });

    expect(text.renders).toHaveBeenCalledTimes(2);
    expect(kind.renders).toHaveBeenCalledTimes(1);
    text.unmount();
    kind.unmount();
  });

  it('F. keeps untouched scope row references while replacing the array', () => {
    const { messages, message } = setup();
    const rows = Array.from({ length: 20 }, (_, index) => message(`message-${index}`, { createdAt: index }));
    for (const row of rows) messages.insertStored(row);
    const view = renderRead(() => messages.scopes.thread.use({ chatId: 'c1' }));
    const before = view.value();

    act(() => {
      messages.patch('message-10', { text: 'patched' });
    });
    const after = view.value();

    expect(after).not.toBe(before);
    expect(after.filter((row: Message) => row.id !== 'message-10').every((row: Message) => row === before.find((beforeRow: Message) => beforeRow.id === row.id))).toBe(true);
    view.unmount();
  });

  it('G. omits membership scope operations for an idempotent member repeat', () => {
    const { plane, messages, message } = setup();
    const row = message('message-1');
    messages.insertStored(row);

    messages.insertStored(row);

    const records = plane.keys('dbl:journal:')
      .map(key => JSON.parse(plane.get(key)!) as { epoch: number; ops: Array<{ kind: string; model: string }> })
      .sort((left, right) => left.epoch - right.epoch);
    const record = records.at(-1)!;
    expect(record.ops.some(op => op.kind === 'scope' && op.model === 'perf-counted-messages')).toBe(false);
  });
});
