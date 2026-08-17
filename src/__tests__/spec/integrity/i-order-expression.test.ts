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

/** Every case names the exact sequence (spec 05): NaN is the greatest value of its field, null is last regardless of direction, ties settle by id, strings by codepoint. */
const CASES: Array<[string, ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>, string[]]> = [
  ['a single ascending numeric key with NaN after every number and null last', [{ field: 'rank', direction: 'asc' }], ['e', 'b', 'a', 'd', 'f', 'c']],
  ['a single descending numeric key brings NaN first and keeps null last', [{ field: 'rank', direction: 'desc' }], ['f', 'a', 'd', 'b', 'e', 'c']],
  ['a string key by codepoint with the empty string first and null last', [{ field: 'label', direction: 'asc' }], ['e', 'd', 'b', 'a', 'f', 'c']],
  [
    'two keys with the second key ordering the ties and the id settling the rest',
    [
      { field: 'rank', direction: 'asc' },
      { field: 'label', direction: 'desc' }
    ],
    ['e', 'b', 'a', 'd', 'f', 'c']
  ]
];

describe('order expression compilation', () => {
  it.each(CASES)('orders %s the same through the live query and the comparator', (_name, orders, expected) => {
    expect(engineOrder(orders)).toEqual(expected);
    expect(comparatorOrder(orders)).toEqual(expected);
  });
});
