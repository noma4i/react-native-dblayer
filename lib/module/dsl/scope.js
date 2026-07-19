"use strict";

/**
 * How an incoming batch of rows reconciles against a scope's existing membership:
 * - `'complete'`: incoming rows become the exact membership in server order; previous members absent
 *   from the response are detached (entity rows themselves are untouched, only scope membership drops).
 * - `'page'`: incoming rows upsert into membership - existing members keep their order, new ones append
 *   in server order; nothing is detached. A first-page refetch (`resetOrder`) makes incoming rows the new
 *   head order, with previous members kept, in their relative order, after them.
 * - `'delta'`: same merge semantics as `'page'`, used for single-row/subscription-driven updates.
 */

/**
 * Declare a model scope configuration for `defineModel`'s `scopes` map. Purely a typed identity marker -
 * it validates and returns `spec` unchanged; `defineModel` builds the actual `ScopeHandle` runtime from it.
 *
 * @param spec Membership mapping (`by`), member order (`sort`), and optional retention cap.
 * @returns `spec`, unchanged.
 */

export function scope(spec) {
  return spec;
}
//# sourceMappingURL=scope.js.map