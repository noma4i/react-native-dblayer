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
  member?: (row: TStored) => boolean;
  sort?:
    | { field: keyof TStored & string; dir: 'asc' | 'desc' }
    | {
        comparator: (a: TStored, b: TStored) => number;
        orderFields?: ReadonlyArray<keyof TStored & string>;
      }
    | 'server-order';
  retention?: { maxRows: number };
}
