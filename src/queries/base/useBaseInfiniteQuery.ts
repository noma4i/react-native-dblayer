import { type InfiniteData, useInfiniteQuery, useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { FetchStatePageInfo, InfiniteQueryConfig, InfiniteQueryResult } from '../../types';
import { computeLoadingState, computePhase } from './loadingState';
import { buildModelFilter } from './shared';

const LOAD_MORE_THROTTLE_MS = 800;
const EMPTY_PAGES: unknown[] = [];

const getPageInfo = <TData, TNode>(config: InfiniteQueryConfig<TData, TNode>, page: TData | undefined): FetchStatePageInfo | undefined => {
  if (!page) return undefined;
  return config.extract(page).pageInfo;
};

const getNextCursor = <TData, TNode>(config: InfiniteQueryConfig<TData, TNode>, page: TData | undefined): string | undefined => {
  if (!page) return undefined;
  const connection = config.extract(page);
  const hasMore = config.direction === 'backward' ? connection.pageInfo.hasPreviousPage : connection.pageInfo.hasNextPage;
  if (!hasMore) return undefined;
  if (config.getCursor) {
    const cursor = config.getCursor(page);
    return cursor != null ? String(cursor) : undefined;
  }
  return config.direction === 'backward' ? (connection.pageInfo.startCursor ?? undefined) : (connection.pageInfo.endCursor ?? undefined);
};

const trimInfiniteDataToFirstPage = <TData>(data: InfiniteData<TData> | undefined): InfiniteData<TData> | undefined => {
  if (!data || data.pages.length <= 1) return data;
  return {
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1)
  };
};

export const useBaseInfiniteQuery = <TData, TNode>(config: InfiniteQueryConfig<TData, TNode>): InfiniteQueryResult<TNode> => {
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();
  const isInactive = config.inactive === true;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isManualLoadingMore, setIsManualLoadingMore] = useState(false);
  const filter = useMemo(() => buildModelFilter(config.getFilter?.(), config.getCurrentUserId?.()), [config.getCurrentUserId, config.getFilter]);
  const fetchState = useMemo(() => (isInactive ? null : (config.collection.getFetchState?.(filter) ?? null)), [config.collection, filter, isInactive]);
  const skipInitialFetch = useMemo(
    () => (isInactive ? false : config.collection.shouldSkipInitialFetch(filter, config.staleTime)),
    [config.collection, config.staleTime, filter, isInactive]
  );
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const shouldSkipInitialFetch = skipInitialFetch && !hasQueryData;
  const readMode = config.readMode ?? 'data';

  const result = useInfiniteQuery<TData, Error, InfiniteData<TData>, readonly unknown[], string | undefined>({
    queryKey: config.queryKey,
    queryFn: ({ pageParam }) => config.queryFn({ pageParam }),
    initialPageParam: undefined,
    getNextPageParam: lastPage => getNextCursor(config, lastPage),
    enabled: config.enabled !== false && !isInactive && !isRestoring && !shouldSkipInitialFetch,
    staleTime: config.staleTime,
    gcTime: config.gcTime
  });

  const pages = result.data?.pages ?? (EMPTY_PAGES as TData[]);
  const lastPage = pages.at(-1);
  const collectionReadInactive = isInactive || readMode === 'none';
  const collectionData = config.collection.useData(filter, collectionReadInactive);
  const finalData = (readMode === 'none' ? EMPTY_PAGES : collectionData) as TNode[];
  const hasData = finalData.length > 0;
  const fallbackPageInfo = fetchState?.pageInfo;
  const lastPageInfo = getPageInfo(config, lastPage) ?? fallbackPageInfo;
  const hasNextPage = lastPageInfo ? (config.direction === 'backward' ? lastPageInfo.hasPreviousPage : lastPageInfo.hasNextPage) : false;
  const hasFetchedData = !isInactive && (result.dataUpdatedAt > 0 || (shouldSkipInitialFetch && fetchState !== null));
  const isFetchingNextPage = result.isFetchingNextPage || isManualLoadingMore;
  const isBackgroundFetching = result.isFetching && hasData && !isFetchingNextPage && !isRefreshing;

  const phase = computePhase({
    isInactive,
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

    const persistedCursor = current.fallbackPageInfo
      ? current.config.direction === 'backward'
        ? (current.fallbackPageInfo.startCursor ?? undefined)
        : (current.fallbackPageInfo.endCursor ?? undefined)
      : undefined;

    if (current.result.data?.pages?.length) {
      void current.result.fetchNextPage();
      return;
    }

    if (!persistedCursor) return;

    setIsManualLoadingMore(true);
    void Promise.resolve(current.config.queryFn({ pageParam: persistedCursor })).finally(() => {
      setIsManualLoadingMore(false);
    });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const current = latestRef.current;
    if (current.isInactive) return;
    if (current.isRefreshing) return;

    setIsRefreshing(true);
    try {
      if (current.result.data?.pages?.length) {
        current.queryClient.setQueryData<InfiniteData<TData>>(current.config.queryKey, cached => trimInfiniteDataToFirstPage(cached));
        await current.result.refetch();
      } else {
        await current.config.queryFn({ pageParam: undefined });
      }
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  return {
    data: finalData,
    items: finalData,
    loadingState,
    hasNextPage,
    isFetchingNextPage,
    isBackgroundFetching,
    fetchNextPage: loadMore,
    loadMore,
    refetch: refresh,
    refresh
  };
};
