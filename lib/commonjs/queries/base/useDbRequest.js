"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useDbSingleRequest = exports.useDbInfiniteRequest = void 0;
var _react = require("react");
var _deriveDbKey = require("../../core/deriveDbKey.js");
var _serialize = require("../../core/serialize.js");
var _extractPage = require("./extractPage.js");
var _requestRuntime = require("./requestRuntime.js");
var _shared = require("./shared.js");
var _useBaseInfiniteQuery = require("./useBaseInfiniteQuery.js");
var _useBaseQuery = require("./useBaseQuery.js");
const resolveSingleRequestKey = config => {
  if (config.key) return config.key;
  if (config.read) {
    return 'id' in config.read ? (0, _deriveDbKey.deriveDbKey)(config.read.model, config.read.id != null ? {
      id: config.read.id
    } : undefined) : (0, _deriveDbKey.deriveDbKey)(config.read.model);
  }
  if (config.sync && typeof config.sync !== 'function') {
    return (0, _deriveDbKey.deriveDbKey)(config.sync.model);
  }
  throw new Error('useDbSingleRequest requires `key` unless `read` or `sync.model` can derive one.');
};
const resolveInfiniteRequestKey = config => {
  if (config.key) return config.key;
  const model = config.read._dbModel;
  if (!model) {
    throw new Error('useDbInfiniteRequest requires `key` unless `read` is created by createCollectionBinding().');
  }
  const modelFilter = (0, _shared.buildModelFilter)((0, _shared.resolveRequestFilter)(config.filter, config.scope), config.currentUserId?.());
  return (0, _deriveDbKey.deriveDbKey)(model, config.read._dbScope?.(modelFilter));
};

/**
 * React hook that runs one GraphQL query, syncs selected data, and returns a reactive read.
 * @param config Query, selection, sync, extract, read, and React Query options.
 * @returns React Query result plus `loadingState`.
 *
 * @example
 * const { data, loadingState } = useDbSingleRequest({
 *   key: ['user', id],
 *   query: USER_QUERY,
 *   vars: { id },
 *   select: data => data.user,
 *   sync: { model: UserModel, contract: 'user' },
 *   read: { model: UserModel, id }
 * });
 */
const useDbSingleRequest = config => {
  const configRef = (0, _react.useRef)(config);
  configRef.current = config;
  const queryKey = resolveSingleRequestKey(config);
  const keySignature = (0, _serialize.stableSerialize)(queryKey);
  const read = config.read;
  const readRef = (0, _react.useRef)(read);
  readRef.current = read;
  const collectionModel = read?.model;
  const collectionHasId = !!read && 'id' in read;
  const collectionId = read && 'id' in read ? read.id : undefined;
  const collection = (0, _react.useMemo)(() => readRef.current, [collectionHasId, collectionId, collectionModel]);
  const baseConfig = (0, _react.useMemo)(() => ({
    queryKey,
    queryFn: () => (0, _requestRuntime.executeDbSingleRequest)(configRef.current),
    collection,
    inactive: config.inactive,
    enabled: config.enabled,
    staleTime: config.staleTime,
    gcTime: config.gcTime,
    refetchOnMount: config.refetchOnMount
  }), [collection, config.enabled, config.gcTime, config.inactive, keySignature, config.query, config.refetchOnMount, config.staleTime]);
  return (0, _useBaseQuery.useBaseQuery)(baseConfig);
};

/**
 * React hook that runs cursor-paginated GraphQL queries and syncs page nodes.
 * @param config Paginated query, connection selector, collection binding, and pagination options.
 * @returns Infinite query result with reactive `items`, loading state, and pagination helpers.
 *
 * @example
 * const feed = useDbInfiniteRequest({
 *   key: ['feed'],
 *   query: FEED_QUERY,
 *   selectPage: data => data.feed,
 *   read: feedCollectionBinding
 * });
 */
exports.useDbSingleRequest = useDbSingleRequest;
const useDbInfiniteRequest = config => {
  const configRef = (0, _react.useRef)(config);
  configRef.current = config;
  const queryKey = resolveInfiniteRequestKey(config);
  const keySignature = (0, _serialize.stableSerialize)(queryKey);
  const baseConfig = (0, _react.useMemo)(() => {
    const extract = (0, _extractPage.makePageExtractor)(data => configRef.current.selectPage(data));
    return {
      queryKey,
      queryFn: ({
        pageParam
      }) => (0, _requestRuntime.executeDbInfiniteRequest)(configRef.current, pageParam),
      extract,
      inactive: config.inactive,
      ...(config.getCursor ? {
        getCursor: data => configRef.current.getCursor(data)
      } : {}),
      enabled: config.enabled,
      staleTime: config.staleTime,
      gcTime: config.gcTime,
      direction: config.direction,
      getFilter: () => (0, _shared.resolveRequestFilter)(configRef.current.filter, configRef.current.scope),
      getCurrentUserId: () => configRef.current.currentUserId?.(),
      ...(config.resolveSyncContract ? {
        resolveSyncContract: context => configRef.current.resolveSyncContract(context)
      } : {}),
      collection: config.read,
      readMode: config.readMode
    };
  }, [config.direction, config.enabled, config.gcTime, config.getCursor, config.inactive, keySignature, config.query, config.read, config.readMode, config.resolveSyncContract, config.scope, config.staleTime]);
  return (0, _useBaseInfiniteQuery.useBaseInfiniteQuery)(baseConfig);
};
exports.useDbInfiniteRequest = useDbInfiniteRequest;
//# sourceMappingURL=useDbRequest.js.map