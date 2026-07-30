import type { LoadMoreOptions, LoadMoreTarget, QueryResult, ScopeWindowResult, WindowPaginationBridge } from '../types';
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
/**
 * THE debounced list-footer advance: bursts of calls (e.g. FlatList onEndReached) collapse into one
 * trailing invocation, guarded at fire time by `hasNextPage`/`isFetchingNextPage` and the `enabled`
 * option. Works over any pagination surface carrying those fields - a `bridgeWindowPagination`
 * result, a scope/query window, or a plain query result.
 *
 * @param target Pagination surface to advance (`hasNextPage`/`isFetchingNextPage`/`fetchNextPage` are read at fire time).
 * @param options Optional `debounceMs` (default 160) and `enabled` fire-time gate (default true).
 * @returns Stable callback for the list footer; safe to call on every end-reached event.
 */
export declare const useLoadMore: (target: LoadMoreTarget, options?: LoadMoreOptions) => (() => void);
//# sourceMappingURL=pagination.d.ts.map