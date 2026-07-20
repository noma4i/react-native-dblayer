"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.computePhase = exports.computeLoadingState = void 0;
/**
 * Compute the current loading phase from query and collection state.
 *
 * Exported so a screen composing a custom loading state out of multiple hook results (rather than
 * consuming one hook's own `loadingState`) can derive the same phase strings this package produces
 * internally, instead of hardcoding them.
 *
 * @param input Query, sync, and data-presence flags for one query/read.
 * @returns The current `LoadingPhase`.
 */
const computePhase = input => {
  if (input.isInactive) return 'idle';
  if (input.isError && !input.hasFetchedData) return 'error';
  if (!input.hasData && (input.isFetching || input.isPaused || input.committedRowsDied)) return 'initial_loading';
  if (input.isRefreshing) return 'refreshing';
  if (input.isFetchingNextPage) return 'loading_more';
  if (!input.hasData && !input.hasFetchedData) return 'initial_loading';
  if (input.isError) return 'error';
  return 'ready';
};

/**
 * Convert a loading phase plus data presence into UI display flags.
 *
 * @param phase Current loading phase from `computePhase`.
 * @param input Query, sync, and data-presence flags for one query/read.
 * @returns A normalized loading-state object for screens and lists.
 */
exports.computePhase = computePhase;
const computeLoadingState = (phase, input) => ({
  phase,
  hasData: input.hasData,
  isReady: phase === 'ready',
  showSkeleton: phase === 'initial_loading',
  showData: phase === 'ready' && input.hasData || phase === 'refreshing' || phase === 'loading_more' || phase === 'error' && input.hasData,
  showEmptyState: phase === 'ready' && !input.hasData,
  showRefreshIndicator: phase === 'refreshing',
  showFooterSpinner: phase === 'loading_more',
  showErrorBanner: phase === 'error',
  isRetrying: input.isFetching && input.retryAttempt > 0,
  retryAttempt: input.retryAttempt,
  isOffline: input.isPaused
});
exports.computeLoadingState = computeLoadingState;
//# sourceMappingURL=loadingState.js.map