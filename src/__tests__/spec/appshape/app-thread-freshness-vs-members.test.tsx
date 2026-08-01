import { act } from 'react';
import { bootDb, configureDb, suspendDb } from '../../testApi';
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
  localPreviewUrl: null,
  clientId: null
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
    suspendDb();

    // The membership record is lost while the freshness record survives - the split this case is about.
    const scopeKeys = storage.snapshotKeys().filter(key => key.startsWith('dbl:scope:'));
    expect(scopeKeys).not.toEqual([]);
    expect(storage.snapshotKeys().filter(key => key.startsWith('dbl:query:'))).not.toEqual([]);
    storage.set(scopeKeys.map(key => ({ key, value: null })));

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
});
