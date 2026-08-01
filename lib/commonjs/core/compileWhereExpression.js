"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.compileWhereExpression = void 0;
var _db = require("@tanstack/db");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _compileDbWhere = require("./compileDbWhere.js");
const isOperatorNode = where => (0, _normalizeHelpers.isNonArrayRecord)(where) && ('and' in where || 'or' in where || 'not' in where);

/** A condition that admits every row. The compiler is total, so a caller never branches on "no filter". */
const MATCHES_EVERY_ROW = () => (0, _db.eq)(1, 1);
const allOf = parts => {
  if (parts.length === 0) return MATCHES_EVERY_ROW();
  return parts.length === 1 ? parts[0] : parts.reduce((left, right) => (0, _db.and)(left, right));
};
const anyOf = parts => {
  // An empty `or` admits nothing, the mirror of an empty `and` admitting everything.
  if (parts.length === 0) return (0, _db.not)(MATCHES_EVERY_ROW());
  return parts.length === 1 ? parts[0] : parts.reduce((left, right) => (0, _db.or)(left, right));
};

/**
 * A row whose field holds no value is not a member of any list, so it satisfies `notIn`. The engine
 * follows SQL, where a comparison against null yields null and `not` keeps it null, which would drop
 * exactly the rows the declared filter admits.
 */
const missing = field => (0, _db.or)((0, _db.isNull)(field), (0, _db.isUndefined)(field));
const comparisons = {
  gt: (field, operand) => (0, _db.gt)(field, operand),
  gte: (field, operand) => (0, _db.gte)(field, operand),
  lt: (field, operand) => (0, _db.lt)(field, operand),
  lte: (field, operand) => (0, _db.lte)(field, operand),
  in: (field, operand) => (0, _db.inArray)(field, operand),
  notIn: (field, operand) => (0, _db.or)((0, _db.not)((0, _db.inArray)(field, operand)), missing(field))
};
const operatorExpressions = (field, operators) => Object.entries(operators).map(([operator, operand]) => comparisons[operator](field, operand));

/**
 * `null` is a VALUE in a stored row, not the absence of one, so the declared filter `{ field: null }`
 * selects the rows whose field is null. The engine's `eq` follows SQL and never matches null, which
 * would silently drop exactly those rows.
 */
const equality = (field, value) => value === null ? (0, _db.isNull)(field) : (0, _db.eq)(field, value);
const leafExpression = (ref, condition) => allOf(Object.entries(condition).filter(([, value]) => value !== undefined).flatMap(([key, value]) => (0, _compileDbWhere.isWhereOperatorValue)(value) ? operatorExpressions(ref[key], value) : [equality(ref[key], value)]));

/**
 * Compile a declared filter into a query expression of the collection engine, so a live query
 * answers the same filter that `matchesDbWhere` answers row by row. One declaration, one meaning:
 * a second hand-written interpretation of the same filter is what lets two read surfaces disagree.
 *
 * @param ref Row reference handed to the query builder's `where` callback.
 * @param where Declared filter; a filter with no condition compiles to a condition every row meets.
 * @returns Boolean expression for the engine's `where` clause.
 */
const compileWhereExpression = (ref, where) => {
  if (!where) return MATCHES_EVERY_ROW();
  if (!isOperatorNode(where)) return leafExpression(ref, where);
  if ('and' in where) return allOf(where.and.map(child => compileWhereExpression(ref, child)));
  if ('or' in where) return anyOf(where.or.map(child => compileWhereExpression(ref, child)));
  // The engine follows SQL: a comparison against a missing value is unknown, and negating unknown
  // keeps it unknown, which drops the row. The declared language has no unknown - a row whose field
  // holds no value is simply not equal to the operand - so unknown is settled to false before `not`.
  return (0, _db.not)((0, _db.coalesce)(compileWhereExpression(ref, where.not), false));
};
exports.compileWhereExpression = compileWhereExpression;
//# sourceMappingURL=compileWhereExpression.js.map