import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { buildScopeKey, ROOT_SCOPE_KEY } from '../../core/compileDbWhere';
import { getCollectionFetchStateVersion, subscribeCollectionFetchState } from '../../core/freshnessStorage';
import { getDbLogger } from '../../core/logger';
import type { BaseQueryCollection, BaseQueryConfig, BaseQueryResult, CollectionFetchState } from '../../types';
import { computeLoadingState, computePhase } from './loadingState';
import { useCollectionRead } from './shared';

type CollectionScope = {
  filter?: { id?: string | null };
  scopeKey: string;
};

type FreshnessGateDecision = {
  fetchState: CollectionFetchState | null;
  shouldSkip: boolean;
};

const resolveCollectionId = (collection: BaseQueryCollection | undefined): string | undefined => collection?.model.collection.id;

const resolveCollectionScope = (collection: BaseQueryConfig<unknown>['collection']): CollectionScope => {
  if (!collection || !('id' in collection)) return { scopeKey: ROOT_SCOPE_KEY };
  const filter = collection.id ? { id: collection.id } : undefined;
  return { filter, scopeKey: buildScopeKey(filter) };
};

const resolveFetchState = (collection: BaseQueryConfig<unknown>['collection']): CollectionFetchState | null => {
  if (!collection) return null;
  if ('id' in collection) return collection.model.getFetchState?.(resolveCollectionScope(collection).filter) ?? null;
  return collection.model.getFetchState?.() ?? null;
};

const logFreshnessSkip = (collection: BaseQueryConfig<unknown>['collection'], scopeKey: string, fetchState: CollectionFetchState | null): void => {
  if (!collection || !fetchState) return;
  getDbLogger().debug('db', 'freshness:skip', {
    model: resolveCollectionId(collection),
    scopeKey,
    ageMs: Date.now() - fetchState.touchedAt,
    empty: fetchState.empty
  });
};

const resolveSkipInitialFetch = (collection: BaseQueryConfig<unknown>['collection'], staleTime?: number, emptyStaleTime?: number): boolean => {
  if (!collection) return false;
  if ('id' in collection) {
    const shouldSkipInitialFetch = collection.model.shouldSkipInitialFetch;
    if (typeof shouldSkipInitialFetch !== 'function') return false;
    return shouldSkipInitialFetch(resolveCollectionScope(collection).filter, staleTime, emptyStaleTime);
  }

  const shouldSkipInitialFetch = collection.model.shouldSkipInitialFetch;
  if (typeof shouldSkipInitialFetch !== 'function') return false;
  return shouldSkipInitialFetch(undefined, staleTime, emptyStaleTime);
};

const resolveFreshnessGateDecision = (collection: BaseQueryConfig<unknown>['collection'], staleTime?: number, emptyStaleTime?: number): FreshnessGateDecision => ({
  fetchState: resolveFetchState(collection),
  shouldSkip: resolveSkipInitialFetch(collection, staleTime, emptyStaleTime)
});

const useCollectionFetchStateVersion = (collection: BaseQueryConfig<unknown>['collection']): number => {
  const collectionId = resolveCollectionId(collection);
  const subscribe = useCallback((listener: () => void) => (collectionId ? subscribeCollectionFetchState(collectionId, listener) : () => {}), [collectionId]);
  const getSnapshot = useCallback(() => (collectionId ? getCollectionFetchStateVersion(collectionId) : 0), [collectionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export const useBaseQuery = <TData>(config: BaseQueryConfig<TData>): BaseQueryResult<TData> => {
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const isInactive = config.inactive === true;
  const freshnessVersion = useCollectionFetchStateVersion(config.collection);
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const { fetchState, shouldSkip: shouldSkipInitialFetch } = useMemo(() => {
    if (isInactive) return { fetchState: null, shouldSkip: false };
    const decision = resolveFreshnessGateDecision(config.collection, config.staleTime, config.emptyStaleTime);
    const shouldSkip = decision.shouldSkip && !hasQueryData;
    if (shouldSkip) {
      logFreshnessSkip(config.collection, resolveCollectionScope(config.collection).scopeKey, decision.fetchState);
    }
    return { fetchState: decision.fetchState, shouldSkip };
  }, [config.collection, config.emptyStaleTime, config.staleTime, freshnessVersion, hasQueryData, isInactive]);

  const result = useQuery<TData, Error>({
    queryKey: config.queryKey,
    queryFn: config.queryFn,
    enabled: config.enabled !== false && !isInactive && !isRestoring && !shouldSkipInitialFetch,
    staleTime: config.staleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  });

  const collectionData = useCollectionRead<TData>(config.collection);
  const hasKnownEmptySingleton = !isInactive && !!config.collection && 'id' in config.collection && fetchState?.empty === true;
  const data = isInactive ? undefined : hasKnownEmptySingleton ? (null as TData) : config.collection ? (collectionData !== undefined ? collectionData : result.data) : result.data;
  const hasData = data !== undefined && data !== null;
  const hasFetchedData = !isInactive && (result.dataUpdatedAt > 0 || (shouldSkipInitialFetch && fetchState !== null));

  const phase = computePhase({
    isInactive,
    isRestoring,
    isSyncReady: true,
    isFetching: result.isFetching,
    hasData,
    isRefreshing: result.isRefetching && !result.isLoading,
    isFetchingNextPage: false,
    isError: result.isError,
    hasFetchedData
  });

  const loadingState = useMemo(() => computeLoadingState(phase, hasData), [phase, hasData]);

  return { ...result, data, loadingState } as BaseQueryResult<TData>;
};
