"use strict";

import { useInfiniteQuery, useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { buildScopeKey } from "../../core/compileDbWhere.js";
import { logFreshnessSkip, useCollectionFetchStateVersion } from "./freshnessGate.js";
import { computeLoadingState, computePhase } from "./loadingState.js";
import { buildModelFilter } from "./shared.js";
const LOAD_MORE_THROTTLE_MS = 800;
const EMPTY_PAGES = [];
const getPageInfo = (config, page) => {
  if (!page) return undefined;
  return config.extract(page).pageInfo;
};
const getNextCursor = (config, page) => {
  if (!page) return undefined;
  const connection = config.extract(page);
  const hasMore = config.direction === 'backward' ? connection.pageInfo.hasPreviousPage : connection.pageInfo.hasNextPage;
  if (!hasMore) return undefined;
  if (config.getCursor) {
    const cursor = config.getCursor(page);
    return cursor != null ? String(cursor) : undefined;
  }
  return config.direction === 'backward' ? connection.pageInfo.startCursor ?? undefined : connection.pageInfo.endCursor ?? undefined;
};
const trimInfiniteDataToFirstPage = data => {
  if (!data || data.pages.length <= 1) return data;
  return {
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1)
  };
};
const resolveStoredScope = (config, filter) => config.collection._dbScope?.(filter) ?? filter;
const resolveFreshnessGateDecision = (config, filter) => ({
  fetchState: config.collection.getFetchState?.(filter) ?? null,
  shouldSkip: config.collection.shouldSkipInitialFetch(filter, config.staleTime, config.emptyStaleTime)
});
export const useBaseInfiniteQuery = config => {
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const isInactive = config.enabled === false;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isManualLoadingMore, setIsManualLoadingMore] = useState(false);
  const filter = useMemo(() => buildModelFilter(config.getFilter?.(), config.getCurrentUserId?.()), [config.getCurrentUserId, config.getFilter]);
  const freshnessVersion = useCollectionFetchStateVersion(config.collection._dbModel?.collection.id);
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const {
    fetchState,
    shouldSkip: shouldSkipInitialFetch
  } = useMemo(() => {
    if (isInactive) {
      return {
        fetchState: config.collection.getFetchState?.(filter) ?? null,
        shouldSkip: false
      };
    }
    const decision = resolveFreshnessGateDecision(config, filter);
    const shouldSkip = decision.shouldSkip && !hasQueryData;
    if (shouldSkip) {
      logFreshnessSkip(config.collection._dbModel?.collection.id, buildScopeKey(resolveStoredScope(config, filter)), decision.fetchState);
    }
    return {
      fetchState: decision.fetchState,
      shouldSkip
    };
  }, [config, filter, freshnessVersion, hasQueryData, isInactive]);
  const readMode = config.readMode ?? 'data';
  const result = useInfiniteQuery({
    queryKey: config.queryKey,
    queryFn: ({
      pageParam
    }) => config.queryFn({
      pageParam
    }),
    initialPageParam: undefined,
    getNextPageParam: lastPage => getNextCursor(config, lastPage),
    enabled: !isInactive && !isRestoring && !shouldSkipInitialFetch,
    staleTime: config.staleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  });
  const pages = result.data?.pages ?? EMPTY_PAGES;
  const lastPage = pages.at(-1);
  const collectionData = config.collection.useData(filter);
  const finalData = readMode === 'none' ? EMPTY_PAGES : collectionData;
  const hasData = finalData.length > 0;
  const fallbackPageInfo = fetchState?.pageInfo;
  const lastPageInfo = getPageInfo(config, lastPage) ?? fallbackPageInfo;
  const hasNextPage = lastPageInfo ? config.direction === 'backward' ? lastPageInfo.hasPreviousPage : lastPageInfo.hasNextPage : false;
  const hasFetchedData = hasData || result.dataUpdatedAt > 0 || fetchState !== null || shouldSkipInitialFetch;
  const isFetchingNextPage = result.isFetchingNextPage || isManualLoadingMore;
  const isBackgroundFetching = result.isFetching && hasData && !isFetchingNextPage && !isRefreshing;
  const isDisplayIdle = isInactive && !hasData;
  const phase = computePhase({
    isInactive: isDisplayIdle,
    isRestoring,
    isSyncReady: true,
    isFetching: result.isFetching || isRefreshing || isManualLoadingMore,
    hasData,
    isRefreshing,
    isFetchingNextPage,
    isError: result.isError,
    hasFetchedData
  });
  const loadingState = useMemo(() => computeLoadingState(phase, hasData), [phase, hasData]);
  const latestRef = useRef({
    config,
    fallbackPageInfo,
    hasNextPage,
    isFetchingNextPage,
    isInactive,
    isRefreshing,
    queryClient,
    result
  });
  const lastLoadMoreAtRef = useRef(0);
  latestRef.current = {
    config,
    fallbackPageInfo,
    hasNextPage,
    isFetchingNextPage,
    isInactive,
    isRefreshing,
    queryClient,
    result
  };
  const loadMore = useCallback(() => {
    const current = latestRef.current;
    if (current.isInactive) return;
    if (!current.hasNextPage || current.isFetchingNextPage || current.isRefreshing) return;
    const now = Date.now();
    if (now - lastLoadMoreAtRef.current < LOAD_MORE_THROTTLE_MS) return;
    lastLoadMoreAtRef.current = now;
    const persistedCursor = current.fallbackPageInfo ? current.config.direction === 'backward' ? current.fallbackPageInfo.startCursor ?? undefined : current.fallbackPageInfo.endCursor ?? undefined : undefined;
    if (current.result.data?.pages?.length) {
      void current.result.fetchNextPage();
      return;
    }
    if (!persistedCursor) return;
    setIsManualLoadingMore(true);
    void Promise.resolve(current.config.queryFn({
      pageParam: persistedCursor
    })).finally(() => {
      setIsManualLoadingMore(false);
    });
  }, []);
  const refresh = useCallback(async () => {
    const current = latestRef.current;
    if (current.isInactive) return;
    if (current.isRefreshing) return;
    setIsRefreshing(true);
    try {
      if (current.result.data?.pages?.length) {
        current.queryClient.setQueryData(current.config.queryKey, cached => trimInfiniteDataToFirstPage(cached));
        await current.result.refetch();
      } else {
        await current.config.queryFn({
          pageParam: undefined
        });
      }
    } finally {
      setIsRefreshing(false);
    }
  }, []);
  return {
    data: finalData,
    loadingState,
    hasNextPage,
    isFetchingNextPage,
    isBackgroundFetching,
    loadMore,
    refetch: refresh
  };
};
//# sourceMappingURL=useBaseInfiniteQuery.js.map