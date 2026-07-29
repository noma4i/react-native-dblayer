"use strict";

import { compareCodepoints, stableSerialize } from "./serialize.js";
const isMissingOrderValue = value => value == null || typeof value === 'number' && Number.isNaN(value) || value instanceof Date && Number.isNaN(value.getTime());
const orderValueRank = value => {
  if (typeof value === 'boolean') return 0;
  if (typeof value === 'number') return 1;
  if (typeof value === 'bigint') return 2;
  if (typeof value === 'string') return 3;
  if (value instanceof Date) return 4;
  return 5;
};

/** Compare supported field-order values as a total order with missing values last. */
export const compareOrderValues = (left, right) => {
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
  if (typeof left === 'number' && typeof right === 'number' || typeof left === 'bigint' && typeof right === 'bigint' || typeof left === 'boolean' && typeof right === 'boolean') {
    return left < right ? -1 : 1;
  }
  return compareCodepoints(stableSerialize(left), stableSerialize(right));
};

/** Add the canonical codepoint id tie-break to a row comparator. */
export const withIdTieBreak = compare => (left, right) => {
  const result = compare(left, right);
  return result === 0 || Number.isNaN(result) ? compareCodepoints(left.id, right.id) : result;
};

/** Build one canonical multi-field row comparator with missing values last and an id tie-break. */
export const createFieldOrderComparator = orderBy => withIdTieBreak((left, right) => {
  for (const order of orderBy) {
    const result = compareOrderValues(left[order.field], right[order.field]);
    if (result === 0) continue;
    if (isMissingOrderValue(left[order.field]) || isMissingOrderValue(right[order.field])) return result;
    return order.direction === 'asc' ? result : -result;
  }
  return 0;
});

/** Build the canonical comparator for a client-sorted scope. */
export const compareRowsBySpec = sort => {
  if ('comparator' in sort) return withIdTieBreak(sort.comparator);
  return createFieldOrderComparator([{
    field: String(sort.field),
    direction: sort.dir
  }]);
};
//# sourceMappingURL=ordering.js.map