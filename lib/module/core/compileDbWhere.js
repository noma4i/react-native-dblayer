"use strict";

import { isNonArrayRecord } from "../utils/normalizeHelpers.js";
import { stableSerialize } from "./serialize.js";
const isOperatorNode = where => {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false;
  return 'and' in where || 'or' in where || 'not' in where;
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