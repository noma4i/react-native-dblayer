"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useBaseQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _react = require("react");
var _freshnessStorage = require("../../core/freshnessStorage.js");
var _logger = require("../../core/logger.js");
var _serialize = require("../../core/serialize.js");
var _loadingState = require("./loadingState.js");
var _shared = require("./shared.js");
const ROOT_SCOPE_KEY = '__root__';
const buildScopeKey = filter => filter ? (0, _serialize.stableSerialize)(filter) : ROOT_SCOPE_KEY;
const resolveCollectionId = collection => collection?.model.collection.id;
const resolveCollectionScope = collection => {
  if (!collection || !('id' in collection)) return {
    scopeKey: ROOT_SCOPE_KEY
  };
  const filter = collection.id ? {
    id: collection.id
  } : undefined;
  return {
    filter,
    scopeKey: buildScopeKey(filter)
  };
};
const resolveFetchState = collection => {
  if (!collection) return null;
  if ('id' in collection) return collection.model.getFetchState?.(resolveCollectionScope(collection).filter) ?? null;
  return collection.model.getFetchState?.() ?? null;
};
const logFreshnessSkip = (collection, scopeKey, fetchState) => {
  if (!collection || !fetchState) return;
  (0, _logger.getDbLogger)().debug('db', 'freshness:skip', {
    model: resolveCollectionId(collection),
    scopeKey,
    ageMs: Date.now() - fetchState.touchedAt,
    empty: fetchState.empty
  });
};
const resolveSkipInitialFetch = (collection, staleTime, emptyStaleTime) => {
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
const resolveFreshnessGateDecision = (collection, staleTime, emptyStaleTime) => ({
  fetchState: resolveFetchState(collection),
  shouldSkip: resolveSkipInitialFetch(collection, staleTime, emptyStaleTime)
});
const useCollectionFetchStateVersion = collection => {
  const collectionId = resolveCollectionId(collection);
  const subscribe = (0, _react.useCallback)(listener => collectionId ? (0, _freshnessStorage.subscribeCollectionFetchState)(collectionId, listener) : () => {}, [collectionId]);
  const getSnapshot = (0, _react.useCallback)(() => collectionId ? (0, _freshnessStorage.getCollectionFetchStateVersion)(collectionId) : 0, [collectionId]);
  return (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
};
const useBaseQuery = config => {
  const queryClient = (0, _reactQuery.useQueryClient)();
  const isRestoring = (0, _reactQuery.useIsRestoring)();
  const isInactive = config.inactive === true;
  const freshnessVersion = useCollectionFetchStateVersion(config.collection);
  const hasQueryData = (queryClient.getQueryState(config.queryKey)?.dataUpdatedAt ?? 0) > 0;
  const {
    fetchState,
    shouldSkip: shouldSkipInitialFetch
  } = (0, _react.useMemo)(() => {
    if (isInactive) return {
      fetchState: null,
      shouldSkip: false
    };
    const decision = resolveFreshnessGateDecision(config.collection, config.staleTime, config.emptyStaleTime);
    const shouldSkip = decision.shouldSkip && !hasQueryData;
    if (shouldSkip) {
      logFreshnessSkip(config.collection, resolveCollectionScope(config.collection).scopeKey, decision.fetchState);
    }
    return {
      fetchState: decision.fetchState,
      shouldSkip
    };
  }, [config.collection, config.emptyStaleTime, config.staleTime, freshnessVersion, hasQueryData, isInactive]);
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