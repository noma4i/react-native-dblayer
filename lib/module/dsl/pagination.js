"use strict";

/** List-ready combination of a scope window (local pagination) and its backing query (network pagination). */

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
export const bridgeWindowPagination = (window, query) => ({
  rows: window.rows,
  totalCount: window.totalCount,
  resolved: window.resolved,
  isPreviousData: window.isPreviousData,
  hasNextPage: window.hasMore || query.hasNextPage,
  isFetchingNextPage: query.isFetchingNextPage,
  fetchNextPage: () => {
    if (window.hasMore) window.fetchNextPage();else query.fetchNextPage();
  },
  loadingState: query.loadingState,
  error: query.error
});
//# sourceMappingURL=pagination.js.map