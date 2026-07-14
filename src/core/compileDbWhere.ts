import { and, eq, isNull, not, or } from '@tanstack/db';
import type { DbReadOptions, DbWhere } from '../types';
import { isNonArrayRecord } from '../utils/normalizeHelpers';
import { toQueryValue } from '../utils/typeBoundary';
import { stableSerialize } from './serialize';

type QueryWithWhere<Q, TRow> = Q & {
  where(callback: (row: { items: TRow }) => unknown): Q;
};

type QueryWithOrderBy<Q, TRow> = Q & {
  orderBy(callback: (row: { items: TRow }) => unknown, direction?: 'asc' | 'desc'): Q;
};

type QueryWithLimit<Q> = Q & {
  limit(count: number): Q;
};

type QueryRow = Record<string, unknown>;
type DbWhereOperator<T> = { and: Array<DbWhere<T>> } | { or: Array<DbWhere<T>> } | { not: DbWhere<T> };

const TRUE_EXPRESSION = eq(1, 1);
const FALSE_EXPRESSION = eq(1, 0);

const isOperatorNode = <TStored>(where: DbWhere<TStored>): where is DbWhereOperator<TStored> => {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false;
  return 'and' in where || 'or' in where || 'not' in where;
};

const combineAnd = (expressions: unknown[]): unknown => {
  if (expressions.length === 0) return undefined;
  if (expressions.length === 1) return expressions[0];
  const [first, second, ...rest] = expressions;
  return and(first as any, second as any, ...(rest as any[]));
};

const combineOr = (expressions: unknown[]): unknown => {
  if (expressions.length === 0) return FALSE_EXPRESSION;
  if (expressions.length === 1) return expressions[0];
  const [first, second, ...rest] = expressions;
  return or(first as any, second as any, ...(rest as any[]));
};

const compileLeafExpression = <TStored>(condition: Partial<TStored>, items: QueryRow): unknown => {
  const expressions = Object.entries(condition)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) =>
      value === null ? isNull(toQueryValue(items[key])) : eq(toQueryValue(items[key]), toQueryValue(value))
    );

  return combineAnd(expressions);
};

export const compileDbWhereExpression = (where: DbWhere<any> | undefined, items: QueryRow): unknown => {
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

export const applyDbWhereToQuery = <TStored, Q>(query: QueryWithWhere<Q, TStored>, where: DbWhere<TStored> | undefined): Q => {
  if (!where) return query;
  return query.where(({ items }) => compileDbWhereExpression(where as DbWhere<any>, items as QueryRow));
};

export const applyDbReadOptionsToQuery = <TStored, Q>(
  query: Q,
  options: DbReadOptions<TStored> | undefined
): Q => {
  let next = query;
  if (options?.orderBy) {
    const { field, direction } = options.orderBy;
    next = (next as QueryWithOrderBy<Q, TStored>).orderBy(({ items }) => toQueryValue((items as QueryRow)[field]), direction);
  }
  if (options?.limit !== undefined) {
    next = (next as QueryWithLimit<Q>).limit(options.limit);
  }
  return next;
};

const leafMatches = <TStored>(row: TStored, condition: Partial<TStored>): boolean =>
  Object.entries(condition)
    .filter(([, value]) => value !== undefined)
    .every(([key, value]) => (row as QueryRow)[key] === value);

export const matchesDbWhere = <TStored>(row: TStored, where: DbWhere<TStored> | undefined): boolean => {
  if (!where) return true;
  if (!isOperatorNode(where)) return leafMatches(row, where as Partial<TStored>);
  if ('and' in where) return where.and.every(child => matchesDbWhere(row, child));
  if ('or' in where) return where.or.some(child => matchesDbWhere(row, child));
  return !matchesDbWhere(row, where.not);
};

export const normalizeDbCondition = <TStored>(condition?: Partial<TStored>): Partial<TStored> | undefined => {
  if (!condition) return undefined;
  const entries = Object.entries(condition).filter(([, value]) => value !== undefined) as Array<[keyof TStored & string, unknown]>;
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries) as Partial<TStored>;
};

/** Sentinel scope key shared by every fetch-state read/write for an empty or missing filter. */
export const ROOT_SCOPE_KEY = '__root__';

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
export const buildScopeKey = (input: unknown): string => {
  if (!isNonArrayRecord(input)) return ROOT_SCOPE_KEY;
  const normalized = normalizeDbCondition(input);
  return normalized ? stableSerialize(normalized) : ROOT_SCOPE_KEY;
};

export const createDbWhereSignature = <TStored>(where: DbWhere<TStored> | undefined, options?: DbReadOptions<TStored>): string =>
  stableSerialize({ where: where ?? null, options: options ?? null });

export const applyDbReadOptionsToRows = <TStored>(rows: TStored[], options?: DbReadOptions<TStored>): TStored[] => {
  let next = rows;
  if (options?.orderBy) {
    const { field, direction } = options.orderBy;
    next = [...next].sort((left, right) => {
      const leftValue = (left as QueryRow)[field];
      const rightValue = (right as QueryRow)[field];
      if (leftValue === rightValue) return 0;
      if (leftValue == null) return direction === 'asc' ? -1 : 1;
      if (rightValue == null) return direction === 'asc' ? 1 : -1;
      return leftValue < rightValue ? (direction === 'asc' ? -1 : 1) : direction === 'asc' ? 1 : -1;
    });
  }
  if (options?.limit !== undefined) {
    next = next.slice(0, options.limit);
  }
  return next;
};
