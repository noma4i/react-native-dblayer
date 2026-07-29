"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.withIdTieBreak = exports.createFieldOrderComparator = exports.compareRowsBySpec = exports.compareOrderValues = void 0;
var _serialize = require("./serialize.js");
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
const compareOrderValues = (left, right) => {
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
  if (typeof left === 'string' && typeof right === 'string') return (0, _serialize.compareCodepoints)(left, right);
  if (left instanceof Date && right instanceof Date) return left.getTime() < right.getTime() ? -1 : 1;
  if (typeof left === 'number' && typeof right === 'number' || typeof left === 'bigint' && typeof right === 'bigint' || typeof left === 'boolean' && typeof right === 'boolean') {
    return left < right ? -1 : 1;
  }
  return (0, _serialize.compareCodepoints)((0, _serialize.stableSerialize)(left), (0, _serialize.stableSerialize)(right));
};

/** Add the canonical codepoint id tie-break to a row comparator. */
exports.compareOrderValues = compareOrderValues;
const withIdTieBreak = compare => (left, right) => {
  const result = compare(left, right);
  return result === 0 || Number.isNaN(result) ? (0, _serialize.compareCodepoints)(left.id, right.id) : result;
};

/** Build one canonical multi-field row comparator with missing values last and an id tie-break. */
exports.withIdTieBreak = withIdTieBreak;
const createFieldOrderComparator = orderBy => withIdTieBreak((left, right) => {
  for (const order of orderBy) {
    const result = compareOrderValues(left[order.field], right[order.field]);
    if (result === 0) continue;
    if (isMissingOrderValue(left[order.field]) || isMissingOrderValue(right[order.field])) return result;
    return order.direction === 'asc' ? result : -result;
  }
  return 0;
});

/** Build the canonical comparator for a client-sorted scope. */
exports.createFieldOrderComparator = createFieldOrderComparator;
const compareRowsBySpec = sort => {
  if ('comparator' in sort) return withIdTieBreak(sort.comparator);
  return createFieldOrderComparator([{
    field: String(sort.field),
    direction: sort.dir
  }]);
};
exports.compareRowsBySpec = compareRowsBySpec;
//# sourceMappingURL=ordering.js.map