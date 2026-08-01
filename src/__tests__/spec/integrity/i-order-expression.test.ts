import { createCollection, createLiveQueryCollection, eq, isNull, isUndefined, not, or } from '@tanstack/db';
import { compileWhereExpression, createFieldOrderComparator, OWNED_COLLECTION_LIFETIME, SyncFeed } from '../../testApi';
import type { WhereOperand, WhereRowRef } from '../../testApi';

type Row = { id: string; rank: number | null; label: string | null };

/**
 * The declared order has one meaning too. A live query that orders rows itself and a comparator that
 * orders the same rows in memory must name the same sequence, including the rows nobody sorts on
 * purpose: missing values, not-a-number and equal keys.
 */
const ROWS: Row[] = [
  { id: 'a', rank: 2, label: 'beta' },
  { id: 'b', rank: 1, label: 'alpha' },
  { id: 'c', rank: null, label: null },
  { id: 'd', rank: 2, label: 'Alpha' },
  { id: 'e', rank: 0, label: '' },
  { id: 'f', rank: Number.NaN, label: 'gamma' }
];

let tag = 0;

const fieldRef = (row: WhereRowRef, field: string): WhereOperand => row[field]!;

// A value that is absent, or a number that equals nothing including itself, is a missing order value.
const missingOrderValue = (field: WhereOperand) => or(isNull(field), isUndefined(field), not(eq(field, field)));

const engineOrder = (orders: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>): string[] => {
  const feed = new SyncFeed<Row>();
  const source = createCollection<Row>({
    ...OWNED_COLLECTION_LIFETIME,
    id: `spec-order-source-${(tag += 1)}`,
    getKey: row => row.id,
    startSync: true,
    sync: { sync: feed.sync }
  });
  feed.start();
  for (const row of ROWS) feed.pushMessage({ type: 'insert', value: row });
  feed.finish();
  feed.markReady();
  const live = createLiveQueryCollection({
    ...OWNED_COLLECTION_LIFETIME,
    id: `spec-order-live-${tag}`,
    startSync: true,
    query: q => {
      const filtered = q.from({ row: source }).where(({ row }) => compileWhereExpression(row, {}));
      return orders
        .reduce(
          (builder, order) =>
            builder
              .orderBy(({ row }) => missingOrderValue(fieldRef(row, order.field)), { direction: 'asc' })
              .orderBy(({ row }) => fieldRef(row, order.field), { direction: order.direction, nulls: 'last', stringSort: 'lexical' }),
          filtered
        )
        .orderBy(({ row }) => row.id, { direction: 'asc', stringSort: 'lexical' });
    },
    getKey: row => row.id
  });
  return [...live.toArray].map(row => (row as Row).id);
};

const comparatorOrder = (orders: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>): string[] =>
  [...ROWS].sort(createFieldOrderComparator(orders)).map(row => row.id);

describe('order expression compilation', () => {
  it('agrees on a single ascending numeric key', () => {
    expect(engineOrder([{ field: 'rank', direction: 'asc' }])).toEqual(comparatorOrder([{ field: 'rank', direction: 'asc' }]));
  });

  it('agrees on a single descending numeric key', () => {
    expect(engineOrder([{ field: 'rank', direction: 'desc' }])).toEqual(comparatorOrder([{ field: 'rank', direction: 'desc' }]));
  });

  it('agrees on a string key by codepoint', () => {
    expect(engineOrder([{ field: 'label', direction: 'asc' }])).toEqual(comparatorOrder([{ field: 'label', direction: 'asc' }]));
  });

  it('agrees on two keys with the id tie-break settling the rest', () => {
    const orders = [
      { field: 'rank', direction: 'asc' as const },
      { field: 'label', direction: 'desc' as const }
    ];

    expect(engineOrder(orders)).toEqual(comparatorOrder(orders));
  });
});
