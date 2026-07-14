"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.normalizeDbCondition = exports.matchesDbWhere = exports.createDbWhereSignature = exports.compileDbWhereExpression = exports.buildScopeKey = exports.applyDbWhereToQuery = exports.applyDbReadOptionsToRows = exports.applyDbReadOptionsToQuery = exports.ROOT_SCOPE_KEY = void 0;
var _db = require("@tanstack/db");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _typeBoundary = require("../utils/typeBoundary.js");
var _serialize = require("./serialize.js");
const TRUE_EXPRESSION = (0, _db.eq)(1, 1);
const FALSE_EXPRESSION = (0, _db.eq)(1, 0);
const isOperatorNode = where => {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false;
  return 'and' in where || 'or' in where || 'not' in where;
};
const combineAnd = expressions => {
  if (expressions.length === 0) return undefined;
  if (expressions.length === 1) return expressions[0];
  const [first, second, ...rest] = expressions;
  return (0, _db.and)(first, second, ...rest);
};
const combineOr = expressions => {
  if (expressions.length === 0) return FALSE_EXPRESSION;
  if (expressions.length === 1) return expressions[0];
  const [first, second, ...rest] = expressions;
  return (0, _db.or)(first, second, ...rest);
};
const compileLeafExpression = (condition, items) => {
  const expressions = Object.entries(condition).filter(([, value]) => value !== undefined).map(([key, value]) => value === null ? (0, _db.isNull)((0, _typeBoundary.toQueryValue)(items[key])) : (0, _db.eq)((0, _typeBoundary.toQueryValue)(items[key]), (0, _typeBoundary.toQueryValue)(value)));
  return combineAnd(expressions);
};
const compileDbWhereExpression = (where, items) => {
  if (!where) return undefined;
  if (!isOperatorNode(where)) {
    return compileLeafExpression(where, items);
  }
  if ('and' in where) {
    return combineAnd(where.and.map(child => compileDbWhereExpression(child, items) ?? TRUE_EXPRESSION));
  }
  if ('or' in where) {
    return combineOr(where.or.map(child => compileDbWhereExpression(child, items) ?? TRUE_EXPRESSION));
  }
  return (0, _db.not)(compileDbWhereExpression(where.not, items) ?? TRUE_EXPRESSION);
};
exports.compileDbWhereExpression = compileDbWhereExpression;
const applyDbWhereToQuery = (query, where) => {
  if (!where) return query;
  return query.where(({
    items
  }) => compileDbWhereExpression(where, items));
};
exports.applyDbWhereToQuery = applyDbWhereToQuery;
const applyDbReadOptionsToQuery = (query, options) => {
  let next = query;
  if (options?.orderBy) {
    const {
      field,
      direction
    } = options.orderBy;
    next = next.orderBy(({
      items
    }) => (0, _typeBoundary.toQueryValue)(items[field]), direction);
  }
  if (options?.limit !== undefined) {
    next = next.limit(options.limit);
  }
  return next;
};
exports.applyDbReadOptionsToQuery = applyDbReadOptionsToQuery;
const leafMatches = (row, condition) => Object.entries(condition).filter(([, value]) => value !== undefined).every(([key, value]) => row[key] === value);
const matchesDbWhere = (row, where) => {
  if (!where) return true;
  if (!isOperatorNode(where)) return leafMatches(row, where);
  if ('and' in where) return where.and.every(child => matchesDbWhere(row, child));
  if ('or' in where) return where.or.some(child => matchesDbWhere(row, child));
  return !matchesDbWhere(row, where.not);
};
exports.matchesDbWhere = matchesDbWhere;
const normalizeDbCondition = condition => {
  if (!condition) return undefined;
  const entries = Object.entries(condition).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
};

/** Sentinel scope key shared by every fetch-state read/write for an empty or missing filter. */
exports.normalizeDbCondition = normalizeDbCondition;
const ROOT_SCOPE_KEY = exports.ROOT_SCOPE_KEY = '__root__';

/**
 * Derive the freshness scope key for a filter/scope value.
 *
 * Single standard shared by every fetch-state read/write path (hook-level `useBaseQuery`/
 * `useBaseInfiniteQuery` and model-level `createCollectionModel`) so the same filter always maps to
 * the same key regardless of which path wrote or reads it - previously each path serialized filters
 * slightly differently (raw truthy-check vs `undefined`-stripping normalization), which could split a
 * single logical scope across two different stored keys.
 *
 * Non-plain-object input (`null`, `undefined`, an array, or a primitive) and a plain object that
 * normalizes to nothing (empty, or every value is `undefined`) both collapse to `ROOT_SCOPE_KEY`.
 */
const buildScopeKey = input => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(input)) return ROOT_SCOPE_KEY;
  const normalized = normalizeDbCondition(input);
  return normalized ? (0, _serialize.stableSerialize)(normalized) : ROOT_SCOPE_KEY;
};
exports.buildScopeKey = buildScopeKey;
const createDbWhereSignature = (where, options) => (0, _serialize.stableSerialize)({
  where: where ?? null,
  options: options ?? null
});
exports.createDbWhereSignature = createDbWhereSignature;
const applyDbReadOptionsToRows = (rows, options) => {
  let next = rows;
  if (options?.orderBy) {
    const {
      field,
      direction
    } = options.orderBy;
    next = [...next].sort((left, right) => {
      const leftValue = left[field];
      const rightValue = right[field];
      if (leftValue === rightValue) return 0;
      if (leftValue == null) return direction === 'asc' ? -1 : 1;
      if (rightValue == null) return direction === 'asc' ? 1 : -1;
      return leftValue < rightValue ? direction === 'asc' ? -1 : 1 : direction === 'asc' ? 1 : -1;
    });
  }
  if (options?.limit !== undefined) {
    next = next.slice(0, options.limit);
  }
  return next;
};
exports.applyDbReadOptionsToRows = applyDbReadOptionsToRows;
//# sourceMappingURL=compileDbWhere.js.map