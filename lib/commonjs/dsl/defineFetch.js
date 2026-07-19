"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineFetch = void 0;
var _react = require("react");
var _reactQuery = require("@tanstack/react-query");
var _loadingState = require("../queries/base/loadingState.js");
var _compileDbWhere = require("../core/compileDbWhere.js");
var _transport = require("../core/transport.js");
var _logger = require("../core/logger.js");
var _runtimePrimitives = require("../utils/runtimePrimitives.js");
var _configure = require("./configure.js");
var _bootValidations = require("./bootValidations.js");
/** Reactive result of `fetchQuery.use(input)`. */

/**
 * Define an ephemeral, store-free fetch: runs GraphQL or a custom fetcher, selects a payload, and exposes it through
 * a reactive TanStack Query-backed hook plus an imperative call. Unlike `defineQuery`, there is no `into`
 * destination - the response never reaches the apply pipeline, never writes a journal record, and never
 * touches a `dbl:` storage key. Use it for display-only data with no local reactive read of its own
 * (pricing tables, country lists, SKU catalogs) where a `defineQuery` write destination would be pure
 * overhead.
 *
 * @param config Document, cache key, `select`, and optional `vars`/`enabled`/`staleTime`/`gcTime`.
 * @returns `{ use, fetch, remove }`. `use(input)` is a hook returning a `FetchResult`. `fetch(input)` runs
 * through the owned query client. `remove()` drops every cached input for this key.
 */
const defineFetch = config => {
  const queryKeyOf = input => ['dbl-fetch', config.key, (0, _compileDbWhere.buildScopeKey)(input)];
  const hasDocument = config.document !== undefined;
  const hasFetcher = config.fetcher !== undefined;
  (0, _bootValidations.registerBootValidation)(() => {
    if (hasDocument === hasFetcher) throw new Error('defineFetch requires exactly one of document or fetcher');
  });
  const execute = async input => {
    const generationFence = (0, _runtimePrimitives.createGenerationFence)();
    let data;
    try {
      if (config.fetcher) {
        data = await config.fetcher(input);
      } else {
        const variables = config.vars?.(input) ?? {};
        data = (await (0, _transport.getDbTransport)().query({
          query: config.document,
          variables
        })).data;
      }
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        (0, _configure.getDbRuntimeConfig)().defaults?.onSyncError?.(reported, {
          source: 'query',
          key: config.key
        });
      } catch (observerError) {
        (0, _logger.getDbLogger)().error('defineFetch onSyncError failed', {
          error: observerError
        });
      }
      throw error;
    }
    if (!generationFence.isCurrent()) {
      throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    }
    return config.select(data);
  };
  const fetch = async input => {
    const generationFence = (0, _runtimePrimitives.createGenerationFence)();
    try {
      return await (0, _configure.getInternalQueryClient)().fetchQuery({
        queryKey: queryKeyOf(input),
        queryFn: () => execute(input),
        staleTime: config.staleTime ?? (0, _configure.getDbRuntimeConfig)().defaults?.staleTime ?? 0,
        gcTime: config.gcTime ?? (0, _configure.getDbRuntimeConfig)().defaults?.gcTime
      });
    } catch (error) {
      if (!generationFence.isCurrent()) {
        throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
      }
      throw error;
    }
  };
  const remove = () => {
    (0, _configure.getInternalQueryClient)().removeQueries({
      queryKey: ['dbl-fetch', config.key]
    });
  };
  const use = input => {
    const enabled = config.enabled ? config.enabled(input) : true;
    const request = (0, _reactQuery.useQuery)({
      queryKey: queryKeyOf(input),
      enabled,
      queryFn: () => execute(input),
      staleTime: config.staleTime ?? (0, _configure.getDbRuntimeConfig)().defaults?.staleTime ?? 0,
      gcTime: config.gcTime ?? (0, _configure.getDbRuntimeConfig)().defaults?.gcTime
    });
    const hasData = Array.isArray(request.data) ? request.data.length > 0 : request.data !== undefined;
    const phase = (0, _loadingState.computePhase)({
      isInactive: !enabled && !hasData,
      isRestoring: false,
      isSyncReady: true,
      isFetching: request.isFetching,
      hasData,
      isRefreshing: request.isRefetching,
      isFetchingNextPage: false,
      isError: request.error != null,
      hasFetchedData: request.isFetched
    });
    const loadingState = (0, _react.useMemo)(() => (0, _loadingState.computeLoadingState)(phase, hasData), [phase, hasData]);
    const refetch = (0, _react.useCallback)(() => {
      void request.refetch();
    }, [request.refetch]);
    return (0, _react.useMemo)(() => ({
      data: request.data,
      loadingState,
      error: request.error,
      refetch
    }), [request.data, loadingState, request.error, refetch]);
  };
  return {
    use,
    fetch,
    remove
  };
};
exports.defineFetch = defineFetch;
//# sourceMappingURL=defineFetch.js.map