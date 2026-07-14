"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _loadingState = require("../queries/base/loadingState.js");
var _configure = require("./configure.js");
var _serialize = require("../core/serialize.js");
const nodesOf = value => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value == null ? [] : [value];
  const connection = value;
  return connection.nodes ?? connection.edges?.flatMap(edge => edge.node == null ? [] : [edge.node]) ?? [value];
};

/** Define a query that compiles selected GraphQL data into a model or scope apply operation. */
const defineQuery = config => {
  const fetch = async scope => {
    if (config.enabled && !config.enabled(scope)) return;
    const data = (await (0, _configure.getDbRuntimeConfig)().transport.query({
      query: config.document,
      variables: config.vars?.(scope)
    })).data;
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const rows = nodesOf(selected);
    if ('__apply' in config.into && typeof config.into.__apply === 'function') {
      config.into.__apply(scope, rows, config.coverage ?? (config.page ? 'page' : 'complete'));
    } else {
      config.into.__applyRows?.(rows);
    }
  };
  return {
    fetch,
    invalidate: scope => {
      (0, _configure.getDbRuntimeConfig)().queryClient?.invalidateQueries({
        queryKey: ['dblayer', config.document, scope === undefined ? undefined : (0, _serialize.stableSerialize)(scope)]
      });
    },
    use: scope => {
      const request = (0, _reactQuery.useQuery)({
        queryKey: ['dblayer', config.document, (0, _serialize.stableSerialize)(scope)],
        queryFn: () => fetch(scope),
        enabled: config.enabled?.(scope) ?? true,
        staleTime: (0, _configure.getDbRuntimeConfig)().defaults?.staleTime,
        gcTime: (0, _configure.getDbRuntimeConfig)().defaults?.gcTime
      });
      const rows = '__apply' in config.into && typeof config.into.__apply === 'function' ? config.into.use(scope) : undefined;
      return {
        data: rows,
        loadingState: (0, _loadingState.computeLoadingState)(request.isFetching ? 'initial_loading' : request.error ? 'error' : 'ready', Array.isArray(rows) && rows.length > 0),
        error: request.error,
        hasNextPage: false,
        isFetchingNextPage: false,
        loadMore: () => {
          void request.refetch();
        },
        refetch: async () => {
          await request.refetch();
        }
      };
    }
  };
};
exports.defineQuery = defineQuery;
//# sourceMappingURL=defineQuery.js.map