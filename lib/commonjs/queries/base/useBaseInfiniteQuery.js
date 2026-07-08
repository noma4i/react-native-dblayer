"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useBaseInfiniteQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _react = require("react");
var _compileDbWhere = require("../../core/compileDbWhere.js");
var _freshnessStorage = require("../../core/freshnessStorage.js");
var _logger = require("../../core/logger.js");
var _loadingState = require("./loadingState.js");
var _shared = require("./shared.js");
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
const logFreshnessSkip = (config, filter, fetchState) => {
  if (!fetchState) return;
  (0, _logger.getDbLogger)().debug('db', 'freshness:skip', {
    model: config.collection._dbModel?.collection.id,
    scopeKey: (0, _compileDbWhere.buildScopeKey)(resolveStoredScope(config, filter)),
    ageMs: Date.now() - fetchState.touchedAt,
    empty: fetchState.empty
  });
};
const resolveFreshnessGateDecision = (config, filter) => ({
  fetchState: config.collection.getFetchState?.(filter) ?? null,
  shouldSkip: config.collection.shouldSkipInitialFetch(filter, config.staleTime, config.emptyStaleTime)
});
const useCollectionFetchStateVersion = config => {
  const collectionId = config.collection._dbModel?.collection.id;
  const subscribe = (0, _react.useCallback)(listener => collectionId ? (0, _freshnessStorage.subscribeCollectionFetchState)(collectionId, listener) : () => {}, [collectionId]);
  const getSnapshot = (0, _react.useCallback)(() => collectionId ? (0, _freshnessStorage.getCollectionFetchStateVersion)(collectionId) : 0, [collectionId]);
  return (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
};
const useBaseInfiniteQuery = config => {
  const queryClient = (0, _reactQuery.useQueryClient)();
  const isRestoring = (0, _reactQuery.useIsRestoring)();
  const isInactive = config.enabled === false;
  const [isRefreshing, setIsRefreshing] = (0, _react.useState)(false);
  const [isManualLoadingMore, setIsManualLoadingMore] = (0, _react.useState)(false);
  const filter = (0, _react.useMemo)(() => (0, _shared.buildModelFilter)(config.getFilter?.(), config.getCurrentUserId?.()), [config.getCurrentUserId, config.getFilter]);
  const freshnessVersion = useCollectionFetchStateVersion(config);
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const {
    fetchState,
    shouldSkip: shouldSkipInitialFetch
  } = (0, _react.useMemo)(() => {
    if (isInactive) return {
      fetchState: null,
      shouldSkip: false
    };
    const decision = resolveFreshnessGateDecision(config, filter);
    const shouldSkip = decision.shouldSkip && !hasQueryData;
    if (shouldSkip) {
      logFreshnessSkip(config, filter, decision.fetchState);
    }
    return {
      fetchState: decision.fetchState,
      shouldSkip
    };
  }, [config, filter, freshnessVersion, hasQueryData, isInactive]);
  const readMode = config.readMode ?? 'data';
  const result = (0, _reactQuery.useInfiniteQuery)({
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
  const collectionReadDisabled = isInactive || readMode === 'none';
  const collectionData = config.collection.useData(filter, collectionReadDisabled);
  const finalData = readMode === 'none' ? EMPTY_PAGES : collectionData;
  const hasData = finalData.length > 0;
  const fallbackPageInfo = fetchState?.pageInfo;
  const lastPageInfo = getPageInfo(config, lastPage) ?? fallbackPageInfo;
  const hasNextPage = lastPageInfo ? config.direction === 'backward' ? lastPageInfo.hasPreviousPage : lastPageInfo.hasNextPage : false;
  const hasFetchedData = !isInactive && (result.dataUpdatedAt > 0 || shouldSkipInitialFetch && fetchState !== null);
  const isFetchingNextPage = result.isFetchingNextPage || isManualLoadingMore;
  const isBackgroundFetching = result.isFetching && hasData && !isFetchingNextPage && !isRefreshing;
  const phase = (0, _loadingState.computePhase)({
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
  const loadingState = (0, _react.useMemo)(() => (0, _loadingState.computeLoadingState)(phase, hasData), [phase, hasData]);
  const latestRef = (0, _react.useRef)({
    config,
    fallbackPageInfo,
    hasNextPage,
    isFetchingNextPage,
    isInactive,
    isRefreshing,
    queryClient,
    result
  });
  const lastLoadMoreAtRef = (0, _react.useRef)(0);
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
  const loadMore = (0, _react.useCallback)(() => {
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
  const refresh = (0, _react.useCallback)(async () => {
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
exports.useBaseInfiniteQuery = useBaseInfiniteQuery;
//# sourceMappingURL=useBaseInfiniteQuery.js.map