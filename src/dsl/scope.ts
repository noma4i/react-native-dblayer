/**
 * How an incoming batch of rows reconciles against a scope's existing membership:
 * - `'complete'`: incoming rows become the exact membership in server order; previous members absent
 *   from the response are detached (entity rows themselves are untouched, only scope membership drops).
 * - `'page'`: incoming rows upsert into membership - existing members keep their order, new ones append
 *   in server order; nothing is detached. A first-page refetch (`resetOrder`) makes incoming rows the new
 *   head order, with previous members kept, in their relative order, after them.
 * - `'delta'`: same merge semantics as `'page'`, used for single-row/subscription-driven updates.
 */
export type ScopeCoverage = 'complete' | 'page' | 'delta';

export interface ScopeSpec<TStored> {
  /**
   * Automatic membership mapping from scope-value fields to stored row fields (e.g. `{ chatId: 'chatId' }`).
   * When set, a row's membership in this scope is derived from its field values on every write: the row
   * joins the scope instance matching its current field values and leaves any scope instance it no longer
   * matches, in the same apply transaction as the write. Omit for scopes populated only by `defineQuery`
   * (via a `ScopeHandle` destination) or explicit `ScopeHandle.seed` calls.
   */
  by?: Record<string, keyof TStored & string>;
  /**
   * Member ordering within the scope:
   * - `{ field, dir }`: sort by a stored field, ascending or descending.
   * - `{ comparator }`: sort with a custom row comparator.
   * - `'server-order'` (default when omitted): preserve the order rows were reconciled into the scope in
   *   (i.e. the order the server/API returned them in) - no client-side resort.
   */
  sort?: { field: keyof TStored & string; dir: 'asc' | 'desc' } | { comparator: (a: TStored, b: TStored) => number } | 'server-order';
  /** Membership cap enforced on first-page refetch (resetOrder) and complete coverage; trimmed ids fall to GC. */
  retention?: { maxRows: number };
}

type StructuralScopeSpec = {
  by?: Record<string, string>;
  sort?: { field: string; dir: 'asc' | 'desc' } | 'server-order';
  retention?: { maxRows: number };
};

/**
 * Declare a model scope configuration for `defineModel`'s `scopes` map. Purely a typed identity marker -
 * it validates and returns `spec` unchanged; `defineModel` builds the actual `ScopeHandle` runtime from it.
 *
 * @param spec Membership mapping (`by`), member order (`sort`), and optional retention cap.
 * @returns `spec`, unchanged.
 */
export function scope<const TSpec extends StructuralScopeSpec>(spec: TSpec): TSpec;
export function scope<TStored>(spec: ScopeSpec<TStored>): ScopeSpec<TStored>;
export function scope(spec: StructuralScopeSpec | ScopeSpec<never>): StructuralScopeSpec | ScopeSpec<never> {
  return spec;
}
