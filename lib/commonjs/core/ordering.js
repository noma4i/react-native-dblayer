"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.withIdTieBreak = exports.sortModelReadRows = exports.pickLowestRow = exports.limitRows = exports.isMultiFieldSort = exports.createFieldOrderComparator = exports.compareRowsBySpec = exports.compareOrderValues = exports.canonicalOrderOptions = void 0;
var _serialize = require("./serialize.js");
/** Narrow a client sort spec to its declared key-list form (`Array.isArray` alone does not narrow `ReadonlyArray` unions). */
const isMultiFieldSort = sort => Array.isArray(sort);

/** A value that carries no position in its own type: not-a-number, and a date that is not a date. */
exports.isMultiFieldSort = isMultiFieldSort;
const isUnorderableValue = value => typeof value === 'number' && Number.isNaN(value) || value instanceof Date && Number.isNaN(value.getTime());
const isMissingOrderValue = value => value == null || isUnorderableValue(value);

/** An absent value: it holds the same place whichever way the order runs. */
const isAbsentOrderValue = value => value == null;
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
  const leftAbsent = isAbsentOrderValue(left);
  const rightAbsent = isAbsentOrderValue(right);
  if (leftAbsent || rightAbsent) {
    if (leftAbsent && rightAbsent) return 0;
    return leftAbsent ? 1 : -1;
  }
  // An unorderable value sorts as the greatest of its field, so reversing the order moves it to the
  // front. Absence, above, does not move: those are the two rules the collection engine applies.
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

/**
 * Pick the single lowest-sorting row. The consumer comparator decides; a tie is settled by the
 * canonical id tie-break, so the answer does not depend on the order rows arrived in. Every
 * `hasOne` read surface resolves through here - a raw reduce would give each surface its own answer.
 *
 * @param rows Candidate rows.
 * @param comparator Consumer comparator; omit to take the first row.
 * @returns The winning row, or `undefined` when there are no candidates.
 */
exports.withIdTieBreak = withIdTieBreak;
const pickLowestRow = (rows, comparator) => {
  if (rows.length === 0) return undefined;
  if (!comparator) return rows[0];
  const compare = withIdTieBreak(comparator);
  return rows.reduce((best, row) => compare(row, best) < 0 ? row : best);
};

/** Build one canonical multi-field row comparator with missing values last and an id tie-break. */
exports.pickLowestRow = pickLowestRow;
const createFieldOrderComparator = orderBy => withIdTieBreak((left, right) => {
  for (const order of orderBy) {
    const result = compareOrderValues(left[order.field], right[order.field]);
    if (result === 0) continue;
    if (isAbsentOrderValue(left[order.field]) || isAbsentOrderValue(right[order.field])) return result;
    return order.direction === 'asc' ? result : -result;
  }
  return 0;
});

/** Build the canonical comparator for a client-sorted scope: comparator, one field, or a declared key list. */
exports.createFieldOrderComparator = createFieldOrderComparator;
const compareRowsBySpec = sort => {
  if (isMultiFieldSort(sort)) return createFieldOrderComparator(sort.map(order => ({
    field: String(order.field),
    direction: order.dir
  })));
  if ('comparator' in sort) return withIdTieBreak(sort.comparator);
  return createFieldOrderComparator([{
    field: String(sort.field),
    direction: sort.dir
  }]);
};

/** Engine order options that reproduce the canonical comparator: absence last, codepoint strings. */
exports.compareRowsBySpec = compareRowsBySpec;
const canonicalOrderOptions = direction => ({
  direction,
  nulls: 'last',
  stringSort: 'lexical'
});

/** Apply an optional non-negative row limit; undefined means no limit. */
exports.canonicalOrderOptions = canonicalOrderOptions;
const limitRows = (rows, limit) => limit === undefined ? rows : rows.slice(0, Math.max(0, limit));

/** Sort a snapshot read by declared keys and cut it to the declared limit. */
exports.limitRows = limitRows;
const sortModelReadRows = (rows, orderBy, limit) => limitRows([...rows].sort(createFieldOrderComparator(orderBy)), limit);
exports.sortModelReadRows = sortModelReadRows;
//# sourceMappingURL=ordering.js.map