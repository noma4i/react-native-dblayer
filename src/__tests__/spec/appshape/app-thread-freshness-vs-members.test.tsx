import { act } from 'react';
import { bootDb, configureDb, getApplyRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, recordTimelineInProvider, settle } from '../helpers/harness';
import { createAppModels } from './appModels';

const document = { kind: 'Document', definitions: [] } as never;

type ThreadResponse = { chat: { messages: { nodes: Array<Record<string, unknown>>; pageInfo: { hasPreviousPage: boolean; startCursor: string | null } } } };

const message = (id: string, sequenceNumber: number) => ({
  id,
  chatId: 'chat-1',
  userId: 'other',
  body: `body-${sequenceNumber}`,
  kind: 'text' as const,
  status: 'Sent' as const,
  createdAt: `2026-07-27T00:0${sequenceNumber}:00Z`,
  updatedAt: `2026-07-27T00:0${sequenceNumber}:00Z`,
  sequenceNumber,
  mediaGroupId: null,
  replyToId: null,
  media: null,
  localPreviewUrl: null
});

/**
 * Freshness and membership are two records in storage, and they can come back apart.
 *
 * The freshness record says a page landed and is still inside its window. The membership record says
 * which rows that page put on the screen. If only the first survives a restart, the reader is told
 * the thread is current while the scope holds nothing - and nothing will ever ask again, because
 * asking is what freshness suppresses. That is a chat that opens empty and stays empty.
 *
 * The declared rule is that freshness follows MATERIALIZATION, so a thread whose members are gone is
 * not fresh whatever its timestamp says.
 */
describe('app-shaped thread freshness against lost members', () => {
  it('T2 refetches a restored thread whose membership did not come back', async () => {
    const history = [1, 2, 3].map(index => message(`m-${index}`, index));
    let calls = 0;
    const storage = createMemoryPlane();
    const build = () => {
      configureDb({
        storage,
        dataVersion: 'app-thread-freshness',
        transport: createMockTransport({
          query: async <TData,>() => {
            calls += 1;
            return { data: { chat: { messages: { nodes: history, pageInfo: { hasPreviousPage: false, startCursor: null } } } } as TData };
          }
        })
      });
      const models = createAppModels('ThreadFreshnessMembers');
      const threadQuery = models.messages.query('thread', {
        document,
        vars: (scope: { chatId: string }) => ({ chatId: scope.chatId }),
        page: (data: ThreadResponse) => data.chat.messages,
        into: models.messages.scopes.thread,
        coverage: 'page',
        direction: 'backward',
        staleTime: 300_000
      });
      return { models, threadQuery };
    };

    const before = build();
    await act(async () => {
      await bootDb();
    });
    const firstReader = recordTimelineInProvider(() => before.threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    await settle(1, { macro: true });
    expect(calls).toBe(1);
    expect((firstReader.last().data as Array<{ id: string }>).map(row => row.id)).toHaveLength(3);
    firstReader.unmount();

    // The membership record is lost while the freshness record survives - the split this case is about.
    const scopeKeys = storage.snapshotKeys().filter(key => key.startsWith('dbl:scope:'));
    expect(scopeKeys).not.toEqual([]);
    expect(storage.snapshotKeys().filter(key => key.startsWith('dbl:query:'))).not.toEqual([]);
    scopeKeys.map(key => ({ key, value: null })).forEach(entry => storage.set(entry.key, entry.value));

    const after = build();
    await act(async () => {
      await bootDb();
    });
    const secondReader = recordTimelineInProvider(() => after.threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    await settle(1, { macro: true });
    const rows = (secondReader.last().data as Array<{ id: string }> | undefined) ?? [];
    secondReader.unmount();

    // A thread that lost its members is not fresh: it owes one more request, and the screen owes the
    // history rather than an empty list nobody will ever refill.
    expect(rows.map(row => row.id).sort()).toEqual(['m-1', 'm-2', 'm-3']);
    expect(calls).toBe(2);
  });

  it('T3 repairs the thread when only its own membership is lost and the sibling scope survives', async () => {
    const history = [1, 2, 3].map(index => message(`m-${index}`, index));
    let calls = 0;
    const storage = createMemoryPlane();
    const build = () => {
      configureDb({
        storage,
        dataVersion: 'app-thread-sibling',
        transport: createMockTransport({
          query: async <TData,>() => {
            calls += 1;
            return { data: { chat: { messages: { nodes: history, pageInfo: { hasPreviousPage: false, startCursor: null } } } } as TData };
          }
        })
      });
      const models = createAppModels('ThreadSiblingScope');
      const threadQuery = models.messages.query('thread', {
        document,
        vars: (scope: { chatId: string }) => ({ chatId: scope.chatId }),
        page: (data: ThreadResponse) => data.chat.messages,
        into: models.messages.scopes.thread,
        coverage: 'page',
        direction: 'backward',
        staleTime: 300_000
      });
      return { models, threadQuery };
    };

    const before = build();
    await act(async () => {
      await bootDb();
    });
    const firstReader = recordTimelineInProvider(() => before.threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    await settle(1, { macro: true });
    expect(calls).toBe(1);
    // The sibling scope over the same rows: this is the Media screen of the same chat.
    before.models.messages.insert({ ...message('m-media', 4), kind: 'video', media: { id: 'media-4', kind: 'video', fileUrl: 'https://cdn/m-4.mp4' } } as never);
    expect(before.models.messages.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'visual' })).toHaveLength(1);
    firstReader.unmount();

    // Exactly the reported split: the thread loses its members while the sibling keeps its own.
    getApplyRuntime().flushCacheSnapshots();
    const threadScopeKeys = storage.snapshotKeys().filter(key => key.startsWith('dbl:scope:') && key.includes('thread'));
    const mediaScopeKeys = storage.snapshotKeys().filter(key => key.startsWith('dbl:scope:') && key.includes('media'));
    expect(threadScopeKeys).not.toEqual([]);
    expect(mediaScopeKeys).not.toEqual([]);
    threadScopeKeys.map(key => ({ key, value: null })).forEach(entry => storage.set(entry.key, entry.value));

    const after = build();
    await act(async () => {
      await bootDb();
    });
    const threadReader = recordTimelineInProvider(() => after.threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    await settle(1, { macro: true });
    const threadRows = (threadReader.last().data as Array<{ id: string }> | undefined) ?? [];
    const mediaRows = after.models.messages.scopes.media.read({ chatId: 'chat-1', mediaBucket: 'visual' }) as Array<{ id: string }>;
    threadReader.unmount();

    // A full sibling beside an empty thread is the screen from the report: the thread has to repair
    // itself rather than present emptiness as the answer.
    expect(mediaRows.map(row => row.id)).toEqual(['m-media']);
    expect(threadRows.map(row => row.id).sort()).toEqual(['m-1', 'm-2', 'm-3']);
    expect(calls).toBe(2);
  });

  it('T4 repairs the thread when the rows are gone and only the membership came back', async () => {
    const history = [1, 2, 3].map(index => message(`m-${index}`, index));
    let calls = 0;
    const storage = createMemoryPlane();
    const build = () => {
      configureDb({
        storage,
        dataVersion: 'app-thread-rows',
        transport: createMockTransport({
          query: async <TData,>() => {
            calls += 1;
            return { data: { chat: { messages: { nodes: history, pageInfo: { hasPreviousPage: false, startCursor: null } } } } as TData };
          }
        })
      });
      const models = createAppModels('ThreadRowsLost');
      const threadQuery = models.messages.query('thread', {
        document,
        vars: (scope: { chatId: string }) => ({ chatId: scope.chatId }),
        page: (data: ThreadResponse) => data.chat.messages,
        into: models.messages.scopes.thread,
        coverage: 'page',
        direction: 'backward',
        staleTime: 300_000
      });
      return { models, threadQuery };
    };

    const before = build();
    await act(async () => {
      await bootDb();
    });
    const firstReader = recordTimelineInProvider(() => before.threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    await settle(1, { macro: true });
    expect(calls).toBe(1);
    firstReader.unmount();

    // The mirror split of T2: membership and freshness survive, the rows behind them do not.
    const rowKeys = storage.snapshotKeys().filter(key => key.startsWith('dbl:row:'));
    expect(rowKeys).not.toEqual([]);
    rowKeys.map(key => ({ key, value: null })).forEach(entry => storage.set(entry.key, entry.value));

    const after = build();
    await act(async () => {
      await bootDb();
    });
    const reader = recordTimelineInProvider(() => after.threadQuery.use({ chatId: 'chat-1' }));
    await settle();
    await settle(1, { macro: true });
    const rows = (reader.last().data as Array<{ id: string }> | undefined) ?? [];
    reader.unmount();

    // Membership pointing at rows nobody can read is not a thread: the screen owes one request and
    // the history, not a list that quietly lost its contents.
    expect(rows.map(row => row.id).sort()).toEqual(['m-1', 'm-2', 'm-3']);
    expect(calls).toBe(2);
  });
});
