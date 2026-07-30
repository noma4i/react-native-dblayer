"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useRelationLoadMore = exports.useLoadMore = exports.bridgeWindowPagination = void 0;
var _react = require("react");
var _pacer = require("@tanstack/pacer");
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
const bridgeWindowPagination = (window, query) => ({
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
exports.bridgeWindowPagination = bridgeWindowPagination;
const useLoadMore = (target, options) => {
  const advanceRef = (0, _react.useRef)(null);
  advanceRef.current = () => {
    if ((options?.enabled ?? true) && target.hasNextPage && !target.isFetchingNextPage) target.fetchNextPage();
  };
  const debouncerRef = (0, _react.useRef)(null);
  debouncerRef.current ??= new _pacer.Debouncer(() => advanceRef.current(), {
    wait: options?.debounceMs ?? 160
  });
  (0, _react.useEffect)(() => () => debouncerRef.current?.cancel(), []);
  return (0, _react.useCallback)(() => debouncerRef.current?.maybeExecute(), []);
};

/**
 * Advance one relation page in one call. Locally available rows are revealed first. When the local
 * window is exhausted, the next server page is fetched and the newly landed local page is revealed
 * immediately after the scope total grows.
 *
 * @param window Current local scope window.
 * @param query Current network pagination state.
 * @param options Debounce and enabled options for the list-footer callback.
 * @returns Stable one-call relation advance.
 */
exports.useLoadMore = useLoadMore;
const useRelationLoadMore = (window, query, options) => {
  const revealAfterFetchCountRef = (0, _react.useRef)(null);
  const {
    fetchNextPage: revealNextPage,
    hasMore: hasLocalMore,
    totalCount
  } = window;
  (0, _react.useEffect)(() => {
    const previousCount = revealAfterFetchCountRef.current;
    if (previousCount === null || totalCount <= previousCount) return;
    revealAfterFetchCountRef.current = null;
    if (hasLocalMore) revealNextPage();
  }, [hasLocalMore, revealNextPage, totalCount]);
  return useLoadMore({
    hasNextPage: hasLocalMore || query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      if (hasLocalMore) {
        revealNextPage();
        return;
      }
      revealAfterFetchCountRef.current = totalCount;
      query.fetchNextPage();
    }
  }, options);
};
exports.useRelationLoadMore = useRelationLoadMore;
//# sourceMappingURL=pagination.js.map