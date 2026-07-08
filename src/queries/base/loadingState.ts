import type { ComputePhaseInput, LoadingPhase, LoadingState } from '../../types';

export const computePhase = (input: ComputePhaseInput): LoadingPhase => {
  if (input.isInactive) return 'idle';
  if (input.isRestoring || !input.isSyncReady) return 'hydrating';
  if (input.isError && !input.hasFetchedData) return 'error';
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
 * @param hasData Whether local or remote data is currently available.
 * @returns A normalized loading-state object for screens and lists.
 */
export const computeLoadingState = (phase: LoadingPhase, hasData: boolean): LoadingState => ({
  phase,
  hasData,
  isReady: phase === 'ready',
  showSkeleton: phase === 'initial_loading',
  showData: (phase === 'ready' && hasData) || phase === 'refreshing' || phase === 'loading_more' || (phase === 'error' && hasData),
  showEmptyState: phase === 'ready' && !hasData,
  showRefreshIndicator: phase === 'refreshing',
  showFooterSpinner: phase === 'loading_more',
  showErrorBanner: phase === 'error'
});
