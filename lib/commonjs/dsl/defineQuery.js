"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _loadingState = require("../queries/base/loadingState.js");
var _compileDbWhere = require("../core/compileDbWhere.js");
var _invalidationRegistry = require("../core/invalidationRegistry.js");
var _configure = require("./configure.js");
const operationKey = (document, override) => {
  if (override) return override;
  const operation = document.definitions?.find(definition => definition.kind === 'OperationDefinition');
  const name = operation?.name?.value;
  if (!name) throw new Error('defineQuery requires a named operation or an explicit key');
  return name;
};
const nodePairsOf = value => {
  if (Array.isArray(value)) return value.map(node => ({
    node,
    edgeSource: node
  }));
  if (!value || typeof value !== 'object') return value == null ? [] : [{
    node: value,
    edgeSource: value
  }];
  const connection = value;
  if (connection.nodes) return connection.nodes.map(node => ({
    node,
    edgeSource: node
  }));
  if (connection.edges) return connection.edges.flatMap(edge => edge.node == null ? [] : [{
    node: edge.node,
    edgeSource: edge
  }]);
  return [{
    node: value,
    edgeSource: value
  }];
};
const isScopeDestination = into => typeof into?.__planApply === 'function';

/** Define a query that compiles GraphQL responses into one apply-pipeline transaction. */
const defineQuery = config => {
  const keyName = operationKey(config.document, config.key);
  const queryKeyOf = scope => ['dbl', keyName, (0, _compileDbWhere.buildScopeKey)(scope)];
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const pageMetaOf = connection => {
    if (!connection) return {
      endCursor: null,
      hasNextPage: false,
      count: 0
    };
    const info = connection.pageInfo ?? {};
    const backward = config.direction === 'backward';
    const cursor = config.getCursor ? config.getCursor(connection) : backward ? info.startCursor ?? null : info.endCursor ?? null;
    const hasNextPage = backward ? info.hasPreviousPage ?? false : info.hasNextPage ?? false;
    const count = connection.nodes?.length ?? connection.edges?.length ?? 0;
    return {
      endCursor: cursor,
      hasNextPage,
      count
    };
  };
  const applyResponse = (scope, data, resetOrder) => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const mapped = config.map ? config.map(selected) : selected;
    const pairs = nodePairsOf(mapped);
    const nodes = pairs.map(pair => pair.node);
    const ops = [];
    if (isScopeDestination(config.into)) {
      const scopeRows = pairs.map(pair => ({
        row: pair.node,
        edge: config.edge?.(pair.edgeSource)
      }));
      ops.push(...(config.into.__planApply?.(scope, scopeRows, coverage, {
        resetOrder
      }) ?? []));
    } else {
      ops.push(...(config.into.__planRows?.(nodes) ?? []));
    }
    for (const sink of config.extract?.({
      data,
      nodes
    }) ?? []) {
      ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
    }
    if (ops.length > 0) (0, _configure.getApplyRuntime)().apply(ops);
    return pageMetaOf(config.page ? config.page(data) : null);
  };
  const runFetch = async (scope, cursor) => {
    const cursorVar = config.cursorVar ?? (config.direction === 'backward' ? 'before' : 'after');
    const variables = {
      ...(config.vars?.(scope) ?? {}),
      ...(cursor != null ? {
        [cursorVar]: config.mapCursor ? config.mapCursor(cursor) : cursor
      } : {})
    };
    const data = (await (0, _configure.getDbRuntimeConfig)().transport.query({
      query: config.document,
      variables: variables
    })).data;
    return applyResponse(scope, data, cursor == null);
  };
  const fetch = async scope => {
    if (config.enabled && !config.enabled(scope)) return;
    await runFetch(scope, null);
  };
  const invalidate = scope => {
    const client = (0, _configure.getDbRuntimeConfig)().queryClient;
    if (!client) return;
    void client.invalidateQueries({
      queryKey: scope === undefined ? ['dbl', keyName] : queryKeyOf(scope)
    });
  };
  const destinationModelId = config.into.modelId;
  if (destinationModelId) (0, _invalidationRegistry.registerModelInvalidation)(destinationModelId, scope => invalidate(scope));
  const isEmptyMeta = data => {
    if (data == null) return true;
    if (typeof data === 'object' && 'pages' in data) {
      return (data.pages ?? []).every(page => page.count === 0);
    }
    return data.count === 0;
  };
  const resolveStaleTime = () => {
    const defaults = (0, _configure.getDbRuntimeConfig)().defaults;
    const base = config.staleTime ?? defaults?.staleTime ?? 0;
    const empty = config.emptyStaleTime ?? defaults?.emptyStaleTime;
    if (empty == null) return base;
    return query => isEmptyMeta(query.state.data) ? empty : base;
  };
  const useDestinationRows = isScopeDestination(config.into) ? scope => config.into.use(scope) : () => undefined;
  const buildResult = (rows, flags) => {
    const hasData = Array.isArray(rows) ? rows.length > 0 : rows !== undefined;
    const phase = (0, _loadingState.computePhase)({
      isInactive: !flags.enabled && !hasData,
      isRestoring: false,
      isSyncReady: true,
      isFetching: flags.isFetching,
      hasData,
      isRefreshing: flags.isRefetching,
      isFetchingNextPage: flags.isFetchingNextPage,
      isError: flags.error != null,
      hasFetchedData: flags.isFetched
    });
    return {
      data: rows,
      loadingState: (0, _loadingState.computeLoadingState)(phase, hasData),
      error: flags.error,
      hasNextPage: flags.hasNextPage,
      isFetchingNextPage: flags.isFetchingNextPage,
      loadMore: flags.loadMore,
      refetch: flags.refetch
    };
  };
  const useInfiniteResult = scope => {
    const enabled = config.enabled?.(scope) ?? true;
    const request = (0, _reactQuery.useInfiniteQuery)({
      queryKey: queryKeyOf(scope),
      enabled,
      initialPageParam: null,
      queryFn: ({
        pageParam
      }) => runFetch(scope, pageParam),
      getNextPageParam: last => last.hasNextPage && last.endCursor != null ? last.endCursor : undefined,
      maxPages: config.maxPages,
      staleTime: resolveStaleTime(),
      gcTime: config.gcTime ?? (0, _configure.getDbRuntimeConfig)().defaults?.gcTime,
      refetchOnMount: config.refetchOnMount
    });
    const rows = useDestinationRows(scope);
    return buildResult(rows, {
      enabled,
      isFetching: request.isFetching,
      isRefetching: request.isRefetching,
      isFetchingNextPage: request.isFetchingNextPage,
      isFetched: request.isFetched,
      error: request.error ?? null,
      hasNextPage: request.hasNextPage,
      loadMore: () => {
        void request.fetchNextPage();
      },
      refetch: async () => {
        await request.refetch();
      }
    });
  };
  const useSingleResult = scope => {
    const enabled = config.enabled?.(scope) ?? true;
    const request = (0, _reactQuery.useQuery)({
      queryKey: queryKeyOf(scope),
      enabled,
      queryFn: () => runFetch(scope, null),
      staleTime: resolveStaleTime(),
      gcTime: config.gcTime ?? (0, _configure.getDbRuntimeConfig)().defaults?.gcTime,
      refetchOnMount: config.refetchOnMount
    });
    const rows = useDestinationRows(scope);
    return buildResult(rows, {
      enabled,
      isFetching: request.isFetching,
      isRefetching: request.isRefetching,
      isFetchingNextPage: false,
      isFetched: request.isFetched,
      error: request.error ?? null,
      hasNextPage: false,
      loadMore: () => {},
      refetch: async () => {
        await request.refetch();
      }
    });
  };
  return {
    use: config.page ? useInfiniteResult : useSingleResult,
    fetch,
    invalidate
  };
};
exports.defineQuery = defineQuery;
//# sourceMappingURL=defineQuery.js.map