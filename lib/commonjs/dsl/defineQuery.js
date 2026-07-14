"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineQuery = void 0;
var _react = require("react");
var _loadingState = require("../queries/base/loadingState.js");
var _configure = require("./configure.js");
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
    invalidate: _scope => {},
    use: scope => {
      const [error, setError] = (0, _react.useState)(null);
      const [isFetching, setFetching] = (0, _react.useState)(false);
      const run = (0, _react.useCallback)(async () => {
        setFetching(true);
        setError(null);
        try {
          await fetch(scope);
        } catch (nextError) {
          setError(nextError);
        } finally {
          setFetching(false);
        }
      }, [scope]);
      (0, _react.useEffect)(() => {
        void run();
      }, [run]);
      const rows = '__apply' in config.into && typeof config.into.__apply === 'function' ? config.into.use(scope) : undefined;
      return {
        data: rows,
        loadingState: (0, _loadingState.computeLoadingState)(isFetching ? 'initial_loading' : error ? 'error' : 'ready', Array.isArray(rows) && rows.length > 0),
        error,
        hasNextPage: false,
        isFetchingNextPage: false,
        loadMore: () => {
          void run();
        },
        refetch: run
      };
    }
  };
};
exports.defineQuery = defineQuery;
//# sourceMappingURL=defineQuery.js.map