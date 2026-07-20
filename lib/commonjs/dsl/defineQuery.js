"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _loadingState = require("../queries/base/loadingState.js");
var _compileDbWhere = require("../core/compileDbWhere.js");
var _invalidationRegistry = require("../core/invalidationRegistry.js");
var _runtimePrimitives = require("../utils/runtimePrimitives.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _configure = require("./configure.js");
var _logger = require("../core/logger.js");
var _internalHandles = require("../core/internalHandles.js");
var _reset = require("../core/reset.js");
/** Reactive result of `query.use(scope)`: fetch/pagination status plus the destination's reactive read. */

/** Reactive result of `query.useRowEnsured(scope, rowId, readOpts?)`. */

const committedRowIdsByQueryScope = new Map();
(0, _reset.registerReset)(() => {
  committedRowIdsByQueryScope.clear();
});
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
  if (!(0, _normalizeHelpers.isRecord)(value)) return value == null ? [] : [{
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
const isScopeDestination = into => typeof into === 'object' && into !== null && (0, _internalHandles.hasInternalScopeHandle)(into);

/**
 * Define a query that runs a GraphQL document, compiles the response into one apply-pipeline transaction
 * (writing rows into `config.into` and any `extract` sinks atomically), and exposes a reactive TanStack
 * Query-backed hook plus imperative fetch/invalidate.
 *
 * @param config Document, variables, response selection (`select` or `page`), write destination, and
 * pagination/freshness options.
 * @returns `{ use, fetch, invalidate }`. `use(scope, opts?)` is a hook - a single-fetch hook when `page` is
 * omitted, an infinite-query hook (paginated) when `page` is set - returning a `QueryResult`. `fetch(scope)`
 * runs one fetch outside React. `invalidate(scope?)` clears the React Query cache for one scope, or every
 * registered scope when `scope` is omitted.
 */
const defineQuery = config => {
  const keyName = operationKey(config.document, config.key);
  const queryKeyOf = scope => ['dbl', keyName, (0, _compileDbWhere.buildScopeKey)(scope)];
  const registeredScopes = new Map();
  const committedRowsKey = scopeKey => `${keyName}\0${scopeKey}`;
  const registerScope = scope => {
    registeredScopes.set((0, _compileDbWhere.buildScopeKey)(scope), scope);
  };
  const matchesPartialScope = (scope, partial) => {
    if (!(0, _normalizeHelpers.isNonArrayRecord)(partial)) return Object.is(scope, partial);
    if (!(0, _normalizeHelpers.isNonArrayRecord)(scope)) return false;
    return Object.entries(partial).every(([key, value]) => Object.is(scope[key], value));
  };
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const committedIdsOf = rows => rows.flatMap(row => (0, _normalizeHelpers.isRecord)(row) && typeof row.id === 'string' ? [row.id] : []);
  const recordCommittedRows = (scope, resetOrder, ids) => {
    const key = committedRowsKey((0, _compileDbWhere.buildScopeKey)(scope));
    committedRowIdsByQueryScope.set(key, resetOrder ? [...new Set(ids)] : [...new Set([...(committedRowIdsByQueryScope.get(key) ?? []), ...ids])]);
  };
  const rowsSurvive = scopeKey => {
    const ids = committedRowIdsByQueryScope.get(committedRowsKey(scopeKey));
    if (!ids || ids.length === 0) return true;
    if (isScopeDestination(config.into)) {
      const scope = registeredScopes.get(scopeKey);
      if (scope === undefined) return true;
      const survivingIds = new Set((0, _internalHandles.getInternalScopeHandle)(config.into).readRows(scope).map(row => row.id));
      return ids.some(id => survivingIds.has(id));
    }
    return ids.some(id => (0, _internalHandles.getInternalModelHandle)(config.into).readRow(id) !== undefined);
  };
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
  const applyResponse = (scope, data, resetOrder, resurrectDestroyed) => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const mapped = config.map ? config.map(selected) : selected;
    const pairs = nodePairsOf(mapped);
    const nodes = pairs.map(pair => pair.node);
    const ops = [];
    let committedIds;
    if (isScopeDestination(config.into)) {
      const scopeRows = pairs.map(pair => ({
        row: pair.node,
        edge: config.edge?.(pair.edgeSource)
      }));
      ops.push(...(0, _internalHandles.getInternalScopeHandle)(config.into).planApply(scope, scopeRows, coverage, {
        resetOrder
      }));
      committedIds = committedIdsOf(scopeRows.map(scopeRow => scopeRow.row));
    } else {
      ops.push(...(0, _internalHandles.getInternalModelHandle)(config.into).planRows(nodes, {
        includeMembership: true,
        ...(resurrectDestroyed ? {
          origin: 'event'
        } : {})
      }));
      committedIds = committedIdsOf(nodes);
    }
    for (const sink of config.extract?.({
      data,
      nodes
    }) ?? []) {
      ops.push(...(0, _internalHandles.getInternalModelHandle)(sink.into).planRows(sink.rows, {
        includeMembership: true
      }));
    }
    if (ops.length > 0) (0, _configure.getApplyRuntime)().apply(ops);
    recordCommittedRows(scope, resetOrder, committedIds);
    return pageMetaOf(config.page ? config.page(data) : null);
  };
  const runFetch = async (scope, cursor, resurrectDestroyed = false) => {
    const cursorVar = config.cursorVar ?? (config.direction === 'backward' ? 'before' : 'after');
    const variables = {
      ...(config.vars?.(scope) ?? {}),
      ...(cursor != null ? {
        [cursorVar]: config.mapCursor ? config.mapCursor(cursor) : cursor
      } : {})
    };
    const generationFence = (0, _runtimePrimitives.createGenerationFence)();
    let data;
    try {
      data = (await (0, _configure.getDbRuntimeConfig)().transport.query({
        query: config.document,
        variables: variables
      })).data;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        (0, _configure.getDbRuntimeConfig)().defaults?.onSyncError?.(reported, {
          source: 'query',
          model: destinationModelId,
          key: keyName
        });
      } catch (observerError) {
        (0, _logger.getDbLogger)().error('defineQuery onSyncError failed', {
          error: observerError
        });
      }
      throw error;
    }
    if (!generationFence.isCurrent()) return {
      endCursor: null,
      hasNextPage: false,
      count: 0
    };
    return applyResponse(scope, data, cursor == null, resurrectDestroyed);
  };
  const fetch = async scope => {
    registerScope(scope);
    if (config.enabled && !config.enabled(scope)) return;
    await runFetch(scope, null);
  };
  const invalidate = scope => {
    const client = (0, _configure.getDbRuntimeConfig)().queryClient;
    if (!client) return;
    if (scope === undefined) {
      void client.invalidateQueries({
        queryKey: ['dbl', keyName]
      });
      return;
    }
    registerScope(scope);
    for (const registeredScope of registeredScopes.values()) {
      if (matchesPartialScope(registeredScope, scope)) void client.invalidateQueries({
        queryKey: queryKeyOf(registeredScope)
      });
    }
  };
  const destinationModelId = config.into.modelId;
  if (destinationModelId) (0, _invalidationRegistry.registerModelInvalidation)(destinationModelId, scope => invalidate(scope));
  const isEmptyMeta = data => {
    if (data == null) return true;
    if ((0, _normalizeHelpers.isRecord)(data) && 'pages' in data) {
      return (data.pages ?? []).every(page => page.count === 0);
    }
    return data.count === 0;
  };
  const resolveStaleTime = () => {
    const defaults = (0, _configure.getDbRuntimeConfig)().defaults;
    const base = config.staleTime ?? defaults?.staleTime ?? 0;
    const empty = config.emptyStaleTime ?? defaults?.emptyStaleTime;
    return query => {
      const scopeKey = query.queryKey[2];
      if (typeof scopeKey === 'string' && !rowsSurvive(scopeKey)) return 0;
      return empty != null && isEmptyMeta(query.state.data) ? empty : base;
    };
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
      isRefreshing: flags.isRefetching || flags.isFetching && hasData && !flags.isFetchingNextPage,
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
      fetchNextPage: flags.fetchNextPage,
      refetch: flags.refetch
    };
  };
  const useInfiniteResult = (scope, options) => {
    registerScope(scope);
    const enabled = (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
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
      fetchNextPage: () => {
        void request.fetchNextPage();
      },
      refetch: async () => {
        await request.refetch();
      }
    });
  };
  const useSingleResult = (scope, options) => {
    registerScope(scope);
    const enabled = (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
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
      fetchNextPage: () => {},
      refetch: async () => {
        await request.refetch();
      }
    });
  };
  const handle = {
    use: config.page ? useInfiniteResult : useSingleResult,
    fetch,
    invalidate
  };
  if (isScopeDestination(config.into)) return handle;
  const destination = config.into;
  const useRowEnsured = (scope, rowId, readOpts) => {
    const row = destination.use.row(rowId, readOpts);
    const enabled = (config.enabled?.(scope) ?? true) && rowId != null && row === undefined;
    const request = (0, _reactQuery.useQuery)({
      queryKey: queryKeyOf(scope),
      enabled,
      queryFn: () => runFetch(scope, null, true),
      staleTime: resolveStaleTime(),
      gcTime: config.gcTime ?? (0, _configure.getDbRuntimeConfig)().defaults?.gcTime,
      refetchOnMount: config.refetchOnMount
    });
    const hasData = row !== undefined;
    const phase = (0, _loadingState.computePhase)({
      isInactive: !enabled && !hasData,
      isRestoring: false,
      isSyncReady: true,
      isFetching: request.isFetching,
      hasData,
      isRefreshing: false,
      isFetchingNextPage: false,
      isError: request.error != null,
      hasFetchedData: request.isFetched || request.isSuccess || request.data !== undefined
    });
    return {
      row,
      loadingState: (0, _loadingState.computeLoadingState)(phase, hasData),
      error: request.error ?? null,
      refetch: async () => {
        await request.refetch();
      }
    };
  };
  return {
    ...handle,
    useRowEnsured
  };
};
exports.defineQuery = defineQuery;
//# sourceMappingURL=defineQuery.js.map