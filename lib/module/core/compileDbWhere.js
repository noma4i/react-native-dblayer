"use strict";

import { and, eq, isNull, not, or } from '@tanstack/db';
import { toQueryValue } from "../utils/typeBoundary.js";
import { stableSerialize } from "./serialize.js";
const TRUE_EXPRESSION = eq(1, 1);
const FALSE_EXPRESSION = eq(1, 0);
const isOperatorNode = where => {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false;
  return 'and' in where || 'or' in where || 'not' in where;
};
const combineAnd = expressions => {
  if (expressions.length === 0) return undefined;
  if (expressions.length === 1) return expressions[0];
  const [first, second, ...rest] = expressions;
  return and(first, second, ...rest);
};
const combineOr = expressions => {
  if (expressions.length === 0) return FALSE_EXPRESSION;
  if (expressions.length === 1) return expressions[0];
  const [first, second, ...rest] = expressions;
  return or(first, second, ...rest);
};
const compileLeafExpression = (condition, items) => {
  const expressions = Object.entries(condition).filter(([, value]) => value !== undefined).map(([key, value]) => value === null ? isNull(toQueryValue(items[key])) : eq(toQueryValue(items[key]), toQueryValue(value)));
  return combineAnd(expressions);
};
export const compileDbWhereExpression = (where, items) => {
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
  return not(compileDbWhereExpression(where.not, items) ?? TRUE_EXPRESSION);
};
export const applyDbWhereToQuery = (query, where) => {
  if (!where) return query;
  return query.where(({
    items
  }) => compileDbWhereExpression(where, items));
};
export const applyDbReadOptionsToQuery = (query, options) => {
  let next = query;
  if (options?.orderBy) {
    const {
      field,
      direction
    } = options.orderBy;
    next = next.orderBy(({
      items
    }) => toQueryValue(items[field]), direction);
  }
  if (options?.limit !== undefined) {
    next = next.limit(options.limit);
  }
  return next;
};
const leafMatches = (row, condition) => Object.entries(condition).filter(([, value]) => value !== undefined).every(([key, value]) => row[key] === value);
export const matchesDbWhere = (row, where) => {
  if (!where) return true;
  if (!isOperatorNode(where)) return leafMatches(row, where);
  if ('and' in where) return where.and.every(child => matchesDbWhere(row, child));
  if ('or' in where) return where.or.some(child => matchesDbWhere(row, child));
  return !matchesDbWhere(row, where.not);
};
export const normalizeDbCondition = condition => {
  if (!condition) return undefined;
  const entries = Object.entries(condition).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
};

/** Sentinel scope key shared by every fetch-state read/write for an empty or missing filter. */
export const ROOT_SCOPE_KEY = '__root__';
const isPlainScopeObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Derive the freshness scope key for a filter/scope value.
 *
 * Single canon shared by every fetch-state read/write path (hook-level `useBaseQuery`/
 * `useBaseInfiniteQuery` and model-level `createCollectionModel`) so the same filter always maps to
 * the same key regardless of which path wrote or reads it - previously each path serialized filters
 * slightly differently (raw truthy-check vs `undefined`-stripping normalization), which could split a
 * single logical scope across two different stored keys.
 *
 * Non-plain-object input (`null`, `undefined`, an array, or a primitive) and a plain object that
 * normalizes to nothing (empty, or every value is `undefined`) both collapse to `ROOT_SCOPE_KEY`.
 */
export const buildScopeKey = input => {
  if (!isPlainScopeObject(input)) return ROOT_SCOPE_KEY;
  const normalized = normalizeDbCondition(input);
  return normalized ? stableSerialize(normalized) : ROOT_SCOPE_KEY;
};
export const createDbWhereSignature = (where, options) => stableSerialize({
  where: where ?? null,
  options: options ?? null
});
export const applyDbReadOptionsToRows = (rows, options) => {
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
//# sourceMappingURL=compileDbWhere.js.map