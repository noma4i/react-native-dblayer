import { act } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { createCollection } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { renderCounted, settleUntil } from '../../__tests__/spec/helpers/harness';

/**
 * Phase-2 PoC item 7 (final): the react-query -> collection sync path. Proves that
 * `queryCollectionOptions` turns a GraphQL-transport-shaped queryFn into collection rows served to
 * live readers, and that a query invalidation lands server deltas into the same collection - the
 * replacement for the whole fetchLedger/RequestState stack in the redesign.
 */
type MessageRow = { id: string; body: string };

describe('TanStack query collection PoC', () => {
  it('hydrates the collection from queryFn and lands refetched server deltas into live readers', async () => {
    let fetchCount = 0;
    const pages: MessageRow[][] = [
      [{ id: 'msg-1', body: 'first' }],
      [
        { id: 'msg-1', body: 'first' },
        { id: 'msg-2', body: 'second' }
      ]
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const messages = createCollection(
      queryCollectionOptions<MessageRow>({
        queryKey: ['poc-messages'],
        queryFn: async () => {
          const page = pages[Math.min(fetchCount, pages.length - 1)]!;
          fetchCount += 1;
          return page;
        },
        queryClient,
        getKey: row => row.id,
        startSync: true
      })
    );
    const reader = renderCounted(() => useLiveQuery(messages).data);

    await act(async () => {
      await settleUntil(() => reader.result().length === 1, 200, { macro: true });
    });
    expect(reader.result().map(row => row.id)).toEqual(['msg-1']);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['poc-messages'] });
      await settleUntil(() => reader.result().length === 2, 200, { macro: true });
    });

    expect(reader.result().map(row => row.id)).toEqual(['msg-1', 'msg-2']);
    expect(fetchCount).toBe(2);
    reader.unmount();
  });
});
