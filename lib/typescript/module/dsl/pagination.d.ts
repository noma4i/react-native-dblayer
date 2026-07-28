import type { QueryResult, ScopeWindowResult, WindowPaginationBridge } from '../types';
/**
 * Combine a scope window (local pagination) with its backing query (network pagination) into one
 * list-ready surface: reveal already-synced rows first, then fetch the next server page. Pure
 * combiner - call it during render; the returned container and its `fetchNextPage` closure are
 * fresh per call (destructure the fields; do not memoize on container identity).
 *
 * @param window `ScopeHandle.useWindow(...)` result for the list's scope.
 * @param query The backing query result (`hasNextPage`/`isFetchingNextPage`/`fetchNextPage`/`loadingState`/`error` are read).
 * @returns One combined pagination surface with window-first `fetchNextPage`.
 */
export declare const bridgeWindowPagination: <T>(window: ScopeWindowResult<T>, query: Pick<QueryResult<unknown>, "hasNextPage" | "isFetchingNextPage" | "fetchNextPage" | "loadingState" | "error">) => WindowPaginationBridge<T>;
//# sourceMappingURL=pagination.d.ts.map