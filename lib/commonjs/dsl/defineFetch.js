"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineFetch = void 0;
var _queryRuntime = require("../queryRuntime.js");
var _loadingState = require("../queries/base/loadingState.js");
var _compileDbWhere = require("../core/compileDbWhere.js");
var _transport = require("../core/transport.js");
var _logger = require("../core/logger.js");
var _configure = require("./configure.js");
/** Reactive result of `fetchQuery.use(input)`. */

/**
 * Define an ephemeral, store-free GraphQL fetch: runs a query, selects a payload, and exposes it through
 * a reactive TanStack Query-backed hook plus an imperative call. Unlike `defineQuery`, there is no `into`
 * destination - the response never reaches the apply pipeline, never writes a journal record, and never
 * touches a `dbl:` storage key. Use it for display-only data with no local reactive read of its own
 * (pricing tables, country lists, SKU catalogs) where a `defineQuery` write destination would be pure
 * overhead.
 *
 * @param config Document, cache key, `select`, and optional `vars`/`enabled`/`staleTime`/`gcTime`.
 * @returns `{ use, fetch }`. `use(input)` is a hook returning a `FetchResult`. `fetch(input)` runs one
 * fetch outside React and resolves to the selected payload, throwing on transport failure.
 */
const defineFetch = config => {
  const queryKeyOf = input => ['dbl-fetch', config.key, (0, _compileDbWhere.buildScopeKey)(input)];
  const fetch = async input => {
    const variables = config.vars?.(input) ?? {};
    const generation = (0, _configure.getRuntimeGeneration)();
    let data;
    try {
      data = (await (0, _transport.getDbTransport)().query({
        query: config.document,
        variables
      })).data;
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
    if (generation !== (0, _configure.getRuntimeGeneration)()) {
      throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    }
    return config.select(data);
  };
  const use = input => {
    const enabled = config.enabled ? config.enabled(input) : true;
    const request = (0, _queryRuntime.useQuery)({
      queryKey: queryKeyOf(input),
      enabled,
      queryFn: () => fetch(input),
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
    return {
      data: request.data,
      loadingState: (0, _loadingState.computeLoadingState)(phase, hasData),
      error: request.error,
      refetch: () => {
        void request.refetch();
      }
    };
  };
  return {
    use,
    fetch
  };
};
exports.defineFetch = defineFetch;
//# sourceMappingURL=defineFetch.js.map