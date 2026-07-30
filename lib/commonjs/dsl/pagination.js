"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useLoadMore = exports.bridgeWindowPagination = void 0;
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
  const advanceRef = (0, _react.useRef)(() => {});
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
exports.useLoadMore = useLoadMore;
//# sourceMappingURL=pagination.js.map