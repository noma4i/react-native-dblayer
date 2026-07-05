"use strict";

export const computePhase = input => {
  if (input.isInactive) return 'idle';
  if (input.isRestoring || !input.isSyncReady) return 'hydrating';
  if (input.isError && !input.hasFetchedData) return 'error';
  if (input.isRefreshing) return 'refreshing';
  if (input.isFetchingNextPage) return 'loading_more';
  if (!input.hasData && !input.hasFetchedData) return 'initial_loading';
  if (input.isError) return 'error';
  return 'ready';
};
export const computeLoadingState = (phase, hasData) => ({
  phase,
  hasData,
  isReady: phase === 'ready',
  showSkeleton: phase === 'initial_loading',
  showData: phase === 'ready' && hasData || phase === 'refreshing' || phase === 'loading_more' || phase === 'error' && hasData,
  showEmptyState: phase === 'ready' && !hasData,
  showRefreshIndicator: phase === 'refreshing',
  showFooterSpinner: phase === 'loading_more',
  showErrorBanner: phase === 'error'
});
//# sourceMappingURL=loadingState.js.map