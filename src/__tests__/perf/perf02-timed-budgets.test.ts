import { belongsTo, hasMany } from '../../core/relations';
import { configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { bestOfThreeMs, journalRecordCount, trackNotifies } from './perfHarness';

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

const configure = (storage: StoragePlane): void => {
  configureDb({
    storage,
    transport: { query: async () => ({ data: {} }), mutation: async () => ({ data: {} }) } as any
  });
};

const defineMessages = (id: string) =>
  defineModel({
    id,
    name: `PerfTimedMessageModel:${id}`,
    fields: { chatId: f.str(), text: f.str(), kind: f.str(), createdAt: f.num() },
    scopes: { thread: scope({ by: { chatId: 'chatId' }, sort: { field: 'createdAt', dir: 'asc' } }) }
  });

const message = (id: string, index: number, chatId = 'c1'): Message => ({ id, chatId, text: `text-${index}`, kind: 'user', createdAt: index });

const setupChatSession = () => {
  const storage = createStorage();
  configure(storage);
  let chats: any;
  let messages: any;
  chats = defineModel({
    id: 'perf-session-chats',
    name: 'PerfSessionChatModel',
    fields: { unreadCount: f.num(), lastText: f.str(), lastActivityAt: f.num() },
    relations: () => ({ messages: hasMany(messages, { foreignKey: 'chatId', dependent: 'destroy' }) })
  });
  messages = defineModel({
    id: 'perf-session-messages',
    name: 'PerfSessionMessageModel',
    fields: { chatId: f.str(), text: f.str(), kind: f.str(), createdAt: f.num() },
    scopes: { thread: scope({ by: { chatId: 'chatId' }, sort: { field: 'createdAt', dir: 'asc' } }) },
    relations: () => ({
      chat: belongsTo(chats, {
        foreignKey: 'chatId',
        touch: (row: Message, chat: { lastActivityAt?: number }) => ({
          lastText: row.text,
          lastActivityAt: Math.max(Number(chat.lastActivityAt ?? 0), row.createdAt)
        }),
        counterCache: { field: 'unreadCount' as any, filter: (row: Message) => row.kind !== 'system' }
      })
    })
  });
  const chatRows = Array.from({ length: 25 }, (_, index) => ({ id: `chat-${index}`, unreadCount: 0, lastText: '', lastActivityAt: 0 }));
  chats.__applyRows?.(chatRows);
  for (let chatIndex = 0; chatIndex < 25; chatIndex += 1) {
    const rows = Array.from({ length: 40 }, (_, messageIndex) => message(`seed-${chatIndex}-${messageIndex}`, messageIndex, `chat-${chatIndex}`));
    messages.scopes.thread.__apply?.({ chatId: `chat-${chatIndex}` }, rows, 'complete');
  }
  return { storage, chats, messages };
};

describe('perf 02: timed budgets', () => {
  it('H. applies twenty rows below the ten-thousand-row budget', () => {
    const storage = createStorage();
    configure(storage);
    const model = defineMessages('perf-apply-large');
    model.__applyRows?.(Array.from({ length: 10_000 }, (_, index) => message(`seed-${index}`, index)));
    const rows = Array.from({ length: 20 }, (_, index) => message(`next-${index}`, 20_000 + index));

    const elapsed = bestOfThreeMs(() => model.__applyRows?.(rows));
    console.info(`perf H ${elapsed.toFixed(3)}ms`);
    expect(elapsed).toBeLessThan(50);
  });

  it('I. publishes one row change below the thousand-subscriber budget', () => {
    const storage = createStorage();
    configure(storage);
    const model = defineMessages('perf-publish-subscribers');
    model.__applyRows?.(Array.from({ length: 1_000 }, (_, index) => message(`row-${index}`, index)));
    const trackers = Array.from({ length: 1_000 }, (_, index) => trackNotifies([{ kind: 'row', model: 'perf-publish-subscribers', id: `row-${index}` }]));
    let sequence = 0;

    const elapsed = bestOfThreeMs(() => {
      sequence += 1;
      model.patch('row-0', { text: `patched-${sequence}` });
    });
    console.info(`perf I ${elapsed.toFixed(3)}ms`);
    expect(elapsed).toBeLessThan(15);
    for (const tracker of trackers) tracker.unsubscribe();
  });

  it('J. reads a thousand-entry field-sorted scope below budget', () => {
    const storage = createStorage();
    configure(storage);
    const model = defineMessages('perf-sorted-scope');
    const rows = Array.from({ length: 1_000 }, (_, index) => message(`row-${index}`, 1_000 - index));
    model.scopes.thread.__apply?.({ chatId: 'c1' }, rows, 'complete');

    const elapsed = bestOfThreeMs(() => {
      model.scopes.thread.read({ chatId: 'c1' });
    });
    console.info(`perf J ${elapsed.toFixed(3)}ms`);
    expect(elapsed).toBeLessThan(15);
  });

  it('K. hydrates ten thousand stored rows below budget', () => {
    const storage = createStorage();
    configure(storage);
    const initial = defineMessages('perf-hydrate');
    initial.__applyRows?.(Array.from({ length: 10_000 }, (_, index) => message(`row-${index}`, index)));

    const elapsed = bestOfThreeMs(() => {
      configure(storage);
      defineMessages('perf-hydrate');
    });
    console.info(`perf K ${elapsed.toFixed(3)}ms`);
    expect(elapsed).toBeLessThan(500);
  });

  it('L. completes chat-session send, incoming, and page workloads below their budgets', () => {
    const { storage, messages } = setupChatSession();
    let sendIndex = 0;
    const sendElapsed = bestOfThreeMs(() => {
      sendIndex += 1;
      const tempId = `temp-send-${sendIndex}`;
      messages.insertStored(message(tempId, 10_000 + sendIndex, 'chat-0'));
      messages.replaceRaw(tempId, message(`server-send-${sendIndex}`, 20_000 + sendIndex, 'chat-0'));
    });
    console.info(`perf L-send ${sendElapsed.toFixed(3)}ms`);
    expect(sendElapsed).toBeLessThan(25);

    let incomingIndex = 0;
    const ingest = messages.ingest({
      received: { handler: () => {
        incomingIndex += 1;
        return { upsert: message(`incoming-${incomingIndex}`, 30_000 + incomingIndex, 'chat-1') };
      } }
    });
    const beforeJournal = journalRecordCount(storage);
    ingest.apply('received', {});
    expect(journalRecordCount(storage)).toBe(beforeJournal + 1);
    const incomingElapsed = bestOfThreeMs(() => ingest.apply('received', {}));
    console.info(`perf L-incoming ${incomingElapsed.toFixed(3)}ms`);
    expect(incomingElapsed).toBeLessThan(25);

    let pageIndex = 0;
    const pageElapsed = bestOfThreeMs(() => {
      pageIndex += 1;
      const rows = Array.from({ length: 20 }, (_, index) => message(`page-${pageIndex}-${index}`, 40_000 + pageIndex * 20 + index, 'chat-2'));
      messages.scopes.thread.__apply?.({ chatId: 'chat-2' }, rows, 'page');
    });
    console.info(`perf L-page ${pageElapsed.toFixed(3)}ms`);
    expect(pageElapsed).toBeLessThan(25);
  });
});
