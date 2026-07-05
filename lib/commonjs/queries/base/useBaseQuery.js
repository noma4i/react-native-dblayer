"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useBaseQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _react = require("react");
var _loadingState = require("./loadingState.js");
var _shared = require("./shared.js");
const resolveFetchState = collection => {
  if (!collection) return null;
  if ('id' in collection) {
    return collection.model.getFetchState?.(collection.id ? {
      id: collection.id
    } : undefined) ?? null;
  }
  return collection.model.getFetchState?.() ?? null;
};
const resolveSkipInitialFetch = (collection, staleTime) => {
  if (!collection) return false;
  if ('id' in collection) {
    const shouldSkipInitialFetch = collection.model.shouldSkipInitialFetch;
    if (typeof shouldSkipInitialFetch !== 'function') return false;
    return shouldSkipInitialFetch(collection.id ? {
      id: collection.id
    } : undefined, staleTime);
  }
  const shouldSkipInitialFetch = collection.model.shouldSkipInitialFetch;
  if (typeof shouldSkipInitialFetch !== 'function') return false;
  return shouldSkipInitialFetch(undefined, staleTime);
};
const useBaseQuery = config => {
  const queryClient = (0, _reactQuery.useQueryClient)();
  const isRestoring = (0, _reactQuery.useIsRestoring)();
  const isInactive = config.inactive === true;
  const skipInitialFetch = (0, _react.useMemo)(() => isInactive ? false : resolveSkipInitialFetch(config.collection, config.staleTime), [config.collection, config.staleTime, isInactive]);
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const shouldSkipInitialFetch = skipInitialFetch && !hasQueryData;
  const fetchState = (0, _react.useMemo)(() => isInactive ? null : resolveFetchState(config.collection), [config.collection, isInactive]);
  const result = (0, _reactQuery.useQuery)({
    queryKey: config.queryKey,
    queryFn: config.queryFn,
    enabled: config.enabled !== false && !isInactive && !isRestoring && !shouldSkipInitialFetch,
    staleTime: config.staleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  });
  const collectionData = (0, _shared.useCollectionRead)(config.collection);
  const hasKnownEmptySingleton = !isInactive && !!config.collection && 'id' in config.collection && fetchState?.empty === true;
  const data = isInactive ? undefined : hasKnownEmptySingleton ? null : config.collection ? collectionData !== undefined ? collectionData : result.data : result.data;
  const hasData = data !== undefined && data !== null;
  const hasFetchedData = !isInactive && (result.dataUpdatedAt > 0 || shouldSkipInitialFetch && fetchState !== null);
  const phase = (0, _loadingState.computePhase)({
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
  const loadingState = (0, _react.useMemo)(() => (0, _loadingState.computeLoadingState)(phase, hasData), [phase, hasData]);
  return {
    ...result,
    data,
    loadingState
  };
};
exports.useBaseQuery = useBaseQuery;
//# sourceMappingURL=useBaseQuery.js.map