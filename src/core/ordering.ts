import type { ClientSort, MultiFieldSort, RowId } from '../types';
import { compareCodepoints, stableSerialize } from './serialize';

/** Narrow a client sort spec to its declared key-list form (`Array.isArray` alone does not narrow `ReadonlyArray` unions). */
export const isMultiFieldSort = <TStored>(sort: ClientSort<TStored>): sort is MultiFieldSort<TStored> => Array.isArray(sort);

const isMissingOrderValue = (value: unknown): boolean =>
  value == null || (typeof value === 'number' && Number.isNaN(value)) || (value instanceof Date && Number.isNaN(value.getTime()));

const orderValueRank = (value: unknown): number => {
  if (typeof value === 'boolean') return 0;
  if (typeof value === 'number') return 1;
  if (typeof value === 'bigint') return 2;
  if (typeof value === 'string') return 3;
  if (value instanceof Date) return 4;
  return 5;
};

/** Compare supported field-order values as a total order with missing values last. */
export const compareOrderValues = (left: unknown, right: unknown): number => {
  const leftMissing = isMissingOrderValue(left);
  const rightMissing = isMissingOrderValue(right);
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }
  if (Object.is(left, right) || left === right) return 0;
  const leftRank = orderValueRank(left);
  const rightRank = orderValueRank(right);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string') return compareCodepoints(left, right);
  if (left instanceof Date && right instanceof Date) return left.getTime() < right.getTime() ? -1 : 1;
  if (
    (typeof left === 'number' && typeof right === 'number') ||
    (typeof left === 'bigint' && typeof right === 'bigint') ||
    (typeof left === 'boolean' && typeof right === 'boolean')
  ) {
    return left < right ? -1 : 1;
  }
  return compareCodepoints(stableSerialize(left), stableSerialize(right));
};

/** Add the canonical codepoint id tie-break to a row comparator. */
export const withIdTieBreak =
  <TRow extends RowId>(compare: (left: TRow, right: TRow) => number): ((left: TRow, right: TRow) => number) =>
  (left, right) => {
    const result = compare(left, right);
    return result === 0 || Number.isNaN(result) ? compareCodepoints(left.id, right.id) : result;
  };

/**
 * Pick the single lowest-sorting row. The consumer comparator decides; a tie is settled by the
 * canonical id tie-break, so the answer does not depend on the order rows arrived in. Every
 * `hasOne` read surface resolves through here - a raw reduce would give each surface its own answer.
 *
 * @param rows Candidate rows.
 * @param comparator Consumer comparator; omit to take the first row.
 * @returns The winning row, or `undefined` when there are no candidates.
 */
export const pickLowestRow = <TRow extends RowId>(
  rows: readonly TRow[],
  comparator?: (left: TRow, right: TRow) => number
): TRow | undefined => {
  if (rows.length === 0) return undefined;
  if (!comparator) return rows[0];
  const compare = withIdTieBreak(comparator);
  return rows.reduce((best, row) => (compare(row, best) < 0 ? row : best));
};

/** Build one canonical multi-field row comparator with missing values last and an id tie-break. */
export const createFieldOrderComparator = <TRow extends RowId & Record<string, unknown>>(
  orderBy: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>
): ((left: TRow, right: TRow) => number) =>
  withIdTieBreak((left, right) => {
    for (const order of orderBy) {
      const result = compareOrderValues(left[order.field], right[order.field]);
      if (result === 0) continue;
      if (isMissingOrderValue(left[order.field]) || isMissingOrderValue(right[order.field])) return result;
      return order.direction === 'asc' ? result : -result;
    }
    return 0;
  });

/** Build the canonical comparator for a client-sorted scope: comparator, one field, or a declared key list. */
export const compareRowsBySpec = <TRow extends RowId & Record<string, unknown>>(sort: ClientSort<TRow>): ((left: TRow, right: TRow) => number) => {
  if (isMultiFieldSort(sort)) return createFieldOrderComparator(sort.map(order => ({ field: String(order.field), direction: order.dir })));
  if ('comparator' in sort) return withIdTieBreak(sort.comparator);
  return createFieldOrderComparator([{ field: String(sort.field), direction: sort.dir }]);
};
