"use strict";

import { isNonArrayRecord } from "../utils/normalizeHelpers.js";
import { compareCodepoints, stableSerialize } from "./serialize.js";
const isOperatorNode = where => {
  if (!isNonArrayRecord(where)) return false;
  return 'and' in where || 'or' in where || 'not' in where;
};

/**
 * The one declaration of the comparison operator set. The type lists the operators, this record
 * names them, and both the row predicate and the query compiler are keyed by it - so an operator
 * that exists in one of the two and not the other does not compile.
 */
export const WHERE_OPERATOR_NAMES = {
  gt: true,
  gte: true,
  lt: true,
  lte: true,
  in: true,
  notIn: true
};
const WHERE_OPERATORS = new Set(Object.keys(WHERE_OPERATOR_NAMES));

/** True when a leaf value is an operator record: a non-empty plain object whose every key is a comparison operator. */
export const isWhereOperatorValue = value => {
  if (!isNonArrayRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => WHERE_OPERATORS.has(key));
};
const compareOrderedValues = (rowValue, operand) => {
  if (typeof rowValue === 'number' && typeof operand === 'number') return rowValue - operand;
  if (typeof rowValue === 'string' && typeof operand === 'string') return compareCodepoints(rowValue, operand);
  return undefined;
};
const operatorMatches = (rowValue, operators) => Object.entries(operators).every(([operator, operand]) => {
  if (operator === 'in') return Array.isArray(operand) && operand.some(candidate => rowValue === candidate);
  if (operator === 'notIn') return Array.isArray(operand) && !operand.some(candidate => rowValue === candidate);
  const compared = compareOrderedValues(rowValue, operand);
  if (compared === undefined || Number.isNaN(compared)) return false;
  if (operator === 'gt') return compared > 0;
  if (operator === 'gte') return compared >= 0;
  if (operator === 'lt') return compared < 0;
  return compared <= 0;
});
const leafMatches = (row, condition) => Object.entries(condition).filter(([, value]) => value !== undefined).every(([key, value]) => isWhereOperatorValue(value) ? operatorMatches(row[key], value) : row[key] === value);
export const matchesDbWhere = (row, where) => {
  if (!where) return true;
  if (!isOperatorNode(where)) return leafMatches(row, where);
  if ('and' in where) return where.and.every(child => matchesDbWhere(row, child));
  if ('or' in where) return where.or.some(child => matchesDbWhere(row, child));
  return !matchesDbWhere(row, where.not);
};
const normalizeDbCondition = condition => {
  const entries = Object.entries(condition).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => compareCodepoints(a, b));
  return Object.fromEntries(entries);
};

/** Sentinel scope key shared by every fetch-state read/write for an empty or missing filter. */
const ROOT_SCOPE_KEY = '__root__';

/**
 * Derive the stable scope key for a filter/scope value.
 *
 * Single standard shared by every fetch-state read/write path (hook-level `useBaseQuery`/
 * `useBaseInfiniteQuery` and model-level `defineModel`) so the same filter always maps to
 * the same key regardless of which path wrote or reads it - previously each path serialized filters
 * slightly differently (raw truthy-check vs `undefined`-stripping normalization), which could split a
 * single logical scope across two different stored keys.
 *
 * `null`/`undefined` and a plain object that normalizes to nothing (empty, or every value is
 * `undefined`) collapse to `ROOT_SCOPE_KEY`. Any other non-record input (string, number, boolean,
 * array) serializes to its own distinct key so primitive scopes never collide.
 */
export const buildScopeKey = input => {
  if (input == null) return ROOT_SCOPE_KEY;
  if (!isNonArrayRecord(input)) return stableSerialize(input);
  const normalized = normalizeDbCondition(input);
  return normalized ? stableSerialize(normalized) : ROOT_SCOPE_KEY;
};
//# sourceMappingURL=compileDbWhere.js.map