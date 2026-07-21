import type { DbWhere } from '../types';
import { isNonArrayRecord } from '../utils/normalizeHelpers';
import { compareCodepoints, stableSerialize } from './serialize';

type QueryRow = Record<string, unknown>;
type DbWhereOperator<T> = { and: Array<DbWhere<T>> } | { or: Array<DbWhere<T>> } | { not: DbWhere<T> };

const isOperatorNode = <TStored>(where: DbWhere<TStored>): where is DbWhereOperator<TStored> => {
  if (!isNonArrayRecord(where)) return false;
  return 'and' in where || 'or' in where || 'not' in where;
};

const WHERE_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains']);

/** True when a leaf value is an operator record: a non-empty plain object whose every key is a comparison operator. */
export const isWhereOperatorValue = (value: unknown): value is Record<string, unknown> => {
  if (!isNonArrayRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => WHERE_OPERATORS.has(key));
};

const compareOrderedValues = (rowValue: unknown, operand: unknown): number | undefined => {
  if (typeof rowValue === 'number' && typeof operand === 'number') return rowValue - operand;
  if (typeof rowValue === 'string' && typeof operand === 'string') return compareCodepoints(rowValue, operand);
  return undefined;
};

const operatorMatches = (rowValue: unknown, operators: Record<string, unknown>): boolean =>
  Object.entries(operators).every(([operator, operand]) => {
    if (operator === 'in') return Array.isArray(operand) && operand.some(candidate => rowValue === candidate);
    if (operator === 'notIn') return Array.isArray(operand) && !operand.some(candidate => rowValue === candidate);
    if (operator === 'contains') return typeof rowValue === 'string' && typeof operand === 'string' && rowValue.includes(operand);
    const compared = compareOrderedValues(rowValue, operand);
    if (compared === undefined || Number.isNaN(compared)) return false;
    if (operator === 'gt') return compared > 0;
    if (operator === 'gte') return compared >= 0;
    if (operator === 'lt') return compared < 0;
    return compared <= 0;
  });

const leafMatches = <TStored>(row: TStored, condition: Partial<TStored>): boolean =>
  Object.entries(condition)
    .filter(([, value]) => value !== undefined)
    .every(([key, value]) => (isWhereOperatorValue(value) ? operatorMatches((row as QueryRow)[key], value) : (row as QueryRow)[key] === value));

export const matchesDbWhere = <TStored>(row: TStored, where: DbWhere<TStored> | undefined): boolean => {
  if (!where) return true;
  if (!isOperatorNode(where)) return leafMatches(row, where as Partial<TStored>);
  if ('and' in where) return where.and.every(child => matchesDbWhere(row, child));
  if ('or' in where) return where.or.some(child => matchesDbWhere(row, child));
  return !matchesDbWhere(row, where.not);
};

const normalizeDbCondition = <TStored>(condition?: Partial<TStored>): Partial<TStored> | undefined => {
  if (!condition) return undefined;
  const entries = Object.entries(condition).filter(([, value]) => value !== undefined) as Array<[keyof TStored & string, unknown]>;
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => compareCodepoints(a, b));
  return Object.fromEntries(entries) as Partial<TStored>;
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
export const buildScopeKey = (input: unknown): string => {
  if (input == null) return ROOT_SCOPE_KEY;
  if (!isNonArrayRecord(input)) return stableSerialize(input);
  const normalized = normalizeDbCondition(input);
  return normalized ? stableSerialize(normalized) : ROOT_SCOPE_KEY;
};
