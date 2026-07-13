import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { buildScopeKey, ROOT_SCOPE_KEY } from '../../core/compileDbWhere';
import type { BaseQueryCollection, BaseQueryConfig, BaseQueryResult, CollectionFetchState, DbRequestSingleData } from '../../types';
import { logFreshnessSkip, useCollectionFetchStateVersion } from './freshnessGate';
import type { FreshnessGateDecision } from './freshnessGate';
import { computeLoadingState, computePhase } from './loadingState';
import { useCollectionRead } from './shared';

type CollectionScope = {
  filter?: { id?: string | null };
  scopeKey: string;
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

type BaseQueryResolvedData<TData, TCollection extends BaseQueryCollection | undefined> = DbRequestSingleData<TData, TData, TCollection>;

export const useBaseQuery = <TData, TCollection extends BaseQueryCollection | undefined = undefined>(
  config: BaseQueryConfig<TData, TCollection>
): BaseQueryResult<BaseQueryResolvedData<TData, TCollection>> => {
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const isInactive = config.enabled === false;
  const freshnessVersion = useCollectionFetchStateVersion(resolveCollectionId(config.collection));
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const { fetchState, shouldSkip: shouldSkipInitialFetch } = useMemo(() => {
    if (isInactive) {
      return {
        fetchState: resolveFetchState(config.collection),
        shouldSkip: false
      };
    }
    const decision = resolveFreshnessGateDecision(config.collection, config.staleTime, config.emptyStaleTime);
    const shouldSkip = decision.shouldSkip && !hasQueryData;
    if (shouldSkip) {
      logFreshnessSkip(resolveCollectionId(config.collection), resolveCollectionScope(config.collection).scopeKey, decision.fetchState);
    }
    return { fetchState: decision.fetchState, shouldSkip };
  }, [config.collection, config.emptyStaleTime, config.staleTime, freshnessVersion, hasQueryData, isInactive]);

  type TResolvedData = BaseQueryResolvedData<TData, TCollection>;
  const result = useQuery<TResolvedData, Error>({
    queryKey: config.queryKey,
    queryFn: config.queryFn as () => Promise<TResolvedData>,
    enabled: !isInactive && !isRestoring && !shouldSkipInitialFetch,
    staleTime: config.staleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  });

  const collectionData = useCollectionRead(config.collection);
  const hasCollectionData = collectionData !== undefined && collectionData !== null;
  const hasKnownEmptySingleton = !!config.collection && 'id' in config.collection && fetchState?.empty === true && !hasCollectionData;
  const data = hasKnownEmptySingleton ? null : config.collection ? (collectionData !== undefined ? collectionData : result.data) : result.data;
  const hasData = data !== undefined && data !== null;
  const hasFetchedData = hasData || result.dataUpdatedAt > 0 || fetchState !== null || shouldSkipInitialFetch;
  const isDisplayIdle = isInactive && !hasData;

  const phase = computePhase({
    isInactive: isDisplayIdle,
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

  return { ...result, data, loadingState } as BaseQueryResult<TResolvedData>;
};
