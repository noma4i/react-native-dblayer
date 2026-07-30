import type { ClientSort } from './dsl.ordering.types';

/**
 * Declarative membership and ordering contract for a model scope.
 *
 * - `by` maps scope-value fields to stored row fields.
 * - `member` adds an extra predicate for `by`-derived scopes.
 * - `sort` controls in-scope ordering.
 * - `retention` caps scope membership during reconciliation.
 */
export interface ScopeSpec<TStored> {
  by?: Record<string, keyof TStored & string>;
  /** Additional membership predicate for `by`-derived scopes. A row joins the scope instance matching its field values only while `member(row)` is true; when a write makes it false the row leaves the scope in the same apply transaction. Requires `by`. Ignored for query-destination scopes (no `by`). */
  member?: { call(row: TStored): boolean }['call'];
  sort?: ClientSort<TStored> | 'server-order';
  retention?: { maxRows: number };
}

