import type { LoadingState } from './db.types';
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
/** Pagination surface `useLoadMore` advances. */
export type LoadMoreTarget = {
    hasMore: boolean;
    isFetchingMore: boolean;
    loadMore: () => void;
} | {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => void;
};
/** Options for `useLoadMore`. */
export type LoadMoreOptions = {
    /** Trailing debounce window in ms (default 160). */
    debounceMs?: number;
    /** When false the advance is suppressed at fire time (e.g. search mode, inactive tab). Default true. */
    enabled?: boolean;
};
//# sourceMappingURL=dsl.pagination.types.d.ts.map