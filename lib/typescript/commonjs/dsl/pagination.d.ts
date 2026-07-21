import type { LoadingState } from '../types';
import type { ScopeWindowResult } from './defineModel';
import type { QueryResult } from './defineQuery';
/** List-ready combination of a scope window (local pagination) and its backing query (network pagination). */
export type WindowPaginationBridge<T> = {
    /** Window rows currently rendered (identity follows the window snapshot). */
    rows: T[];
    /** Total locally-synced rows for the scope key. */
    totalCount: number;
    /** True once the scope has reconciled at least once. */
    resolved: boolean;
    /** True while rows belong to the previous scope key. */
    isPreviousData: boolean;
    /** More rows are available locally or on the server. */
    hasNextPage: boolean;
    /** True while a network next-page fetch is in flight. */
    isFetchingNextPage: boolean;
    /** Window-first advance: grow the local window while it has more, otherwise fetch the next server page. */
    fetchNextPage: () => void;
    /** The backing query's loading-state machine. */
    loadingState: LoadingState;
    /** The backing query's last error, or null. */
    error: Error | null;
};
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