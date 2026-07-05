import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { BaseQueryConfig, BaseQueryResult } from '../../types';
import { computeLoadingState, computePhase } from './loadingState';
import { useCollectionRead } from './shared';

const resolveFetchState = (collection: BaseQueryConfig<unknown>['collection']) => {
  if (!collection) return null;
  if ('id' in collection) {
    return collection.model.getFetchState?.(collection.id ? { id: collection.id } : undefined) ?? null;
  }
  return collection.model.getFetchState?.() ?? null;
};

const resolveSkipInitialFetch = (collection: BaseQueryConfig<unknown>['collection'], staleTime?: number): boolean => {
  if (!collection) return false;

  if ('id' in collection) {
    const shouldSkipInitialFetch = collection.model.shouldSkipInitialFetch;
    if (typeof shouldSkipInitialFetch !== 'function') return false;
    return shouldSkipInitialFetch(collection.id ? { id: collection.id } : undefined, staleTime);
  }

  const shouldSkipInitialFetch = collection.model.shouldSkipInitialFetch;
  if (typeof shouldSkipInitialFetch !== 'function') return false;
  return shouldSkipInitialFetch(undefined, staleTime);
};

export const useBaseQuery = <TData>(config: BaseQueryConfig<TData>): BaseQueryResult<TData> => {
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const isInactive = config.inactive === true;
  const skipInitialFetch = useMemo(
    () => (isInactive ? false : resolveSkipInitialFetch(config.collection, config.staleTime)),
    [config.collection, config.staleTime, isInactive]
  );
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const shouldSkipInitialFetch = skipInitialFetch && !hasQueryData;
  const fetchState = useMemo(() => (isInactive ? null : resolveFetchState(config.collection)), [config.collection, isInactive]);

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
