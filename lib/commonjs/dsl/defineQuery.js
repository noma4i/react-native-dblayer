"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.intoIf = exports.defineQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _esToolkit = require("es-toolkit");
var _react = require("react");
var _pagination = require("./pagination.js");
var _loadingState = require("../queries/base/loadingState.js");
var _commitEnvelope = require("../core/apply/commitEnvelope.js");
var _compileDbWhere = require("../core/compileDbWhere.js");
var _serialize = require("../core/serialize.js");
var _invalidationRegistry = require("../core/invalidationRegistry.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _configure = require("./configure.js");
var _transport = require("../core/transport.js");
var _internalHandles = require("../core/internalHandles.js");
var _fetchReaderRegistry = require("../core/fetch/fetchReaderRegistry.js");
var _networkState = require("../core/fetch/networkState.js");
var _queryFreshness = require("../core/fetch/queryFreshness.js");
var _reset = require("../core/reset.js");
var _keyedLocalState = require("../core/fetch/keyedLocalState.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _connection = require("../queries/base/connection.js");
var _syncError = require("../core/syncError.js");
/**
 * Create one extract sink only when a row exists; pair with the `{ into, rows }` extract contract.
 *
 * @param into Extract destination.
 * @param row Optional source row.
 * @returns One extract sink, or an empty list.
 */
const intoIf = (into, row) => row == null ? [] : [{
  into,
  rows: [row]
}];
exports.intoIf = intoIf;
const issuedResetSeqByBucket = new Map();
const appliedResetSeqByBucket = new Map();
(0, _reset.registerReset)(() => {
  issuedResetSeqByBucket.clear();
  appliedResetSeqByBucket.clear();
});
const operationKey = (document, override) => {
  if (override) return override;
  const operation = document.definitions?.find(definition => definition.kind === 'OperationDefinition');
  const name = operation?.name?.value;
  if (!name) throw new Error('defineQuery requires a named operation or an explicit key');
  return name;
};
const nodesOf = value => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (!(0, _normalizeHelpers.isRecord)(value)) throw new Error('defineQuery select/page must return rows, a row, or a connection');
  const connection = value;
  if (connection.nodes) return [...connection.nodes];
  if (connection.edges) return connection.edges.flatMap(edge => edge?.node == null ? [] : [edge.node]);
  return [value];
};
const isScopeDestination = into => (0, _normalizeHelpers.isRecord)(into) && (0, _internalHandles.hasInternalScopeHandle)(into);
/** Fail fast at define time, then rewrite the `connection` shorthand into the one `page` seam - dense nodes, pageInfo passthrough. */
const normalizeQueryConfig = config => {
  const readConnection = config.connection;
  if (!readConnection) return config;
  if (config.page || config.select) throw new Error('defineQuery: connection is mutually exclusive with page/select');
  return {
    ...config,
    connection: undefined,
    page: data => {
      const value = readConnection(data);
      return {
        nodes: (0, _connection.fromNodes)(value),
        pageInfo: value?.pageInfo
      };
    }
  };
};
/** Define a coordinator-owned GraphQL query: react-query drives freshness/single-flight/retry, results land through the store's write seams. */
const defineQuery = rawConfig => {
  const config = normalizeQueryConfig(rawConfig);
  const keyName = operationKey(config.document, config.key);
  const registeredScopes = new Map();
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const destinationModelId = config.into.modelId;
  const destinationScope = isScopeDestination(config.into) ? (0, _internalHandles.getInternalScopeHandle)(config.into) : null;
  /** Fields react-query cannot express in our vocabulary: offline pause and next-page distinction. */
  const localState = (0, _keyedLocalState.createKeyedLocalState)({
    isPaused: false,
    isFetchingNextPage: false
  });
  const setLocalState = (key, next) => localState.set(key, next);
  (0, _reset.registerKeyedReset)(`query:${keyName}`, () => {
    registeredScopes.clear();
    issuedResetSeqByBucket.clear();
    appliedResetSeqByBucket.clear();
    localState.clear();
  });
  const bucketKeyOf = scope => (0, _serialize.compositeKey)(keyName, (0, _compileDbWhere.buildScopeKey)(scope));
  const queryKeyOf = key => [keyName, key];
  const normalizeScope = scope => destinationScope ? destinationScope.normalize(scope) : scope;
  const registerScope = rawScope => {
    if (rawScope === null) return null;
    const scope = normalizeScope(rawScope);
    destinationScope?.key(scope);
    registeredScopes.set((0, _compileDbWhere.buildScopeKey)(scope), scope);
    return scope;
  };
  const matchesPartialScope = (scope, partial) => {
    if (!(0, _normalizeHelpers.isNonArrayRecord)(partial)) return Object.is(scope, partial);
    if (!(0, _normalizeHelpers.isNonArrayRecord)(scope)) return false;
    return Object.entries(partial).every(([key, value]) => Object.is(scope[key], value));
  };
  const pageMetaOf = connection => {
    const info = connection.pageInfo ?? {};
    const backward = config.direction === 'backward';
    return {
      endCursor: config.getCursor ? config.getCursor(connection) : backward ? info.startCursor ?? null : info.endCursor ?? null,
      hasNextPage: backward ? info.hasPreviousPage ?? false : info.hasNextPage ?? false,
      count: connection.nodes?.length ?? connection.edges?.length ?? 0
    };
  };
  const applyResponse = (scope, data, resetOrder, resurrectDestroyed) => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const nodes = nodesOf(selected);
    const ops = [];
    const rows = isScopeDestination(config.into) ? nodes.map(node => ({
      row: node
    })) : [];
    if (isScopeDestination(config.into)) ops.push(...(0, _internalHandles.getInternalScopeHandle)(config.into).planApply(scope, rows, coverage, {
      resetOrder
    }));else ops.push(...(0, _internalHandles.getInternalModelHandle)(config.into).planRows(nodes, resurrectDestroyed ? {
      origin: 'event'
    } : undefined));
    for (const sink of config.extract?.({
      data,
      nodes
    }) ?? []) ops.push(...(0, _internalHandles.getInternalModelHandle)(sink.into).planRows(sink.rows));
    if (ops.length > 0) (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(ops));
    const committedRows = isScopeDestination(config.into) ? rows.map(entry => entry.row) : nodes;
    const ids = committedRows.map(row => (0, _serialize.compositeKey)(destinationModelId, String(row.id)));
    const meta = config.page ? pageMetaOf(config.page(data)) : {
      endCursor: null,
      hasNextPage: false,
      count: nodes.length
    };
    return {
      meta,
      ids,
      resultKind: config.page || Array.isArray(selected) ? 'many' : 'one'
    };
  };
  const execute = async (scope, key, resurrectDestroyed, context) => {
    const cursorVar = config.cursorVar ?? (config.direction === 'backward' ? 'before' : 'after');
    const variables = {
      ...(config.vars?.(scope) ?? {}),
      ...(context.cursor != null ? {
        [cursorVar]: config.mapCursor ? config.mapCursor(context.cursor) : context.cursor
      } : {})
    };
    const scopeKey = (0, _compileDbWhere.buildScopeKey)(scope);
    const guardKey = isScopeDestination(config.into) ? (0, _serialize.compositeKey)(destinationModelId, (0, _internalHandles.getInternalScopeHandle)(config.into).key(scope)) : (0, _serialize.compositeKey)(keyName, scopeKey);
    const reset = context.cursor === null;
    const issued = reset ? (issuedResetSeqByBucket.get(guardKey) ?? 0) + 1 : issuedResetSeqByBucket.get(guardKey);
    if (reset) issuedResetSeqByBucket.set(guardKey, issued);
    let data;
    try {
      data = (0, _transport.responseDataOrThrow)(await (0, _configure.getDbRuntimeConfig)().transport.query({
        query: config.document,
        variables: variables
      }));
    } catch (error) {
      if (!context.isCurrent()) throw error;
      (0, _syncError.reportSyncError)(error, {
        source: 'query',
        model: destinationModelId,
        key: keyName
      }, 'defineQuery');
      throw error;
    }
    if (!context.isCurrent()) return null;
    const applied = appliedResetSeqByBucket.get(guardKey) ?? 0;
    if (reset && issued < applied || !reset && issued < issuedResetSeqByBucket.get(guardKey)) return null;
    if (reset) appliedResetSeqByBucket.set(guardKey, issued);
    const result = applyResponse(scope, data, reset, resurrectDestroyed);
    const previous = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(key));
    const previousPages = previous?.pages ?? 0;
    const pages = config.page ? reset ? 1 : previousPages + 1 : 1;
    /** maxPages is a hard ceiling: once reached, the chain reports exhaustion and fetchNextPage stops issuing requests. */
    const hasNextPage = result.meta.hasNextPage && (config.maxPages === undefined || pages < config.maxPages);
    return {
      lastCount: result.meta.count,
      cursor: config.page && hasNextPage ? result.meta.endCursor : null,
      pages,
      hasNextPage,
      ids: reset ? result.ids : (0, _esToolkit.union)(previous.ids, result.ids),
      resultKind: result.resultKind
    };
  };
  const staleTimeOf = key => {
    const meta = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(key));
    const defaults = (0, _configure.getDbRuntimeConfig)().defaults;
    return meta?.lastCount === 0 && ((0, _queryFreshness.resolveStaleTime)(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null ? (0, _queryFreshness.resolveStaleTime)(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime : (0, _queryFreshness.resolveStaleTime)(config.staleTime, defaults) ?? defaults.staleTime ?? 0;
  };
  const run = async (scope, options) => {
    (0, _queryFreshness.resolveStaleTime)(config.staleTime, (0, _configure.getDbRuntimeConfig)().defaults);
    (0, _queryFreshness.resolveStaleTime)(config.emptyStaleTime, (0, _configure.getDbRuntimeConfig)().defaults);
    if (config.enabled && !config.enabled(scope)) return;
    const key = bucketKeyOf(scope);
    const client = (0, _configure.getDbQueryClient)();
    const queryKey = queryKeyOf(key);
    if (!(0, _networkState.isFetchNetworkOnline)()) {
      setLocalState(key, {
        isPaused: true
      });
      return;
    }
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({
      queryKey
    });
    setLocalState(key, {
      isPaused: false,
      isFetchingNextPage: options.nextPage === true
    });
    const generationFence = (0, _runtimeGeneration.createGenerationFence)();
    try {
      await client.fetchQuery({
        queryKey,
        queryFn: async () => {
          const chainCursor = options.restart ? null : client.getQueryData(queryKey)?.cursor ?? null;
          const cursor = options.nextPage ? chainCursor : null;
          const meta = await execute(scope, key, options.resurrectDestroyed === true, {
            cursor,
            isCurrent: generationFence.isCurrent
          });
          if (meta === null) {
            return client.getQueryData(queryKey) ?? {
              lastCount: 0,
              cursor: null,
              pages: 0,
              hasNextPage: false,
              ids: [],
              resultKind: 'one'
            };
          }
          return meta;
        },
        staleTime: options.restart || options.nextPage ? 0 : staleTimeOf(key)
      });
    } catch (error) {
      if (!generationFence.isCurrent()) {
        if (options.propagateFailure) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
        return;
      }
      // A newer restart cancelled this fetch; the superseding run now owns key state and outcome.
      if (error instanceof _reactQuery.CancelledError) return;
      if (!(0, _networkState.isFetchNetworkOnline)()) {
        setLocalState(key, {
          isPaused: true,
          isFetchingNextPage: false
        });
        return;
      }
      setLocalState(key, {
        isFetchingNextPage: false
      });
      if (options.propagateFailure) throw error instanceof Error ? error : new Error(String(error));
      return;
    }
    if (!generationFence.isCurrent()) return;
    setLocalState(key, {
      isPaused: false,
      isFetchingNextPage: false
    });
  };
  /** `requiredScope` gate: a nullish declared key means "this scope is not addressable yet" - identical to `scope: null`. */
  const scopeGate = scope => scope !== null && config.requiredScope?.some(key => scope[key] == null) ? null : scope;
  const fetch = async rawScope => {
    const scope = registerScope(scopeGate(rawScope));
    if (scope === null) return;
    await run(scope, {
      restart: true,
      propagateFailure: true
    });
  };
  const invalidateRegisteredScope = registered => {
    const client = (0, _configure.getDbQueryClient)();
    const queryKey = queryKeyOf(bucketKeyOf(registered));
    // Invalidation is lazy: freshness drops for everyone, but only mounted readers refetch now.
    void client.invalidateQueries({
      queryKey,
      refetchType: 'none'
    }).then(() => {
      (0, _fetchReaderRegistry.refetchActiveFetchReaders)(queryKey);
    });
  };
  const invalidateMatching = partial => {
    for (const registered of registeredScopes.values()) {
      if (!matchesPartialScope(registered, partial)) continue;
      invalidateRegisteredScope(registered);
    }
  };
  const invalidateAll = () => {
    for (const registered of registeredScopes.values()) invalidateRegisteredScope(registered);
  };
  const invalidate = scope => {
    if (scope === undefined) {
      invalidateAll();
      return;
    }
    const normalized = registerScope(scope);
    if (normalized !== null) invalidateMatching(normalized);
  };
  if (destinationModelId) {
    (0, _invalidationRegistry.registerModelInvalidation)(destinationModelId, keyName, scope => {
      if (scope === undefined) {
        invalidateAll();
        return;
      }
      if (destinationScope && !destinationScope.isComplete(scope)) return;
      invalidateMatching(normalizeScope(scope));
    });
  }
  const useObservedState = key => {
    const client = (0, _configure.getDbQueryClient)();
    const generation = (0, _configure.getRuntimeGeneration)();
    const observerRef = (0, _react.useRef)(null);
    if (observerRef.current === null || observerRef.current.key !== key || observerRef.current.generation !== generation) {
      observerRef.current = {
        key,
        generation,
        observer: new _reactQuery.QueryObserver(client, {
          queryKey: queryKeyOf(key),
          enabled: false,
          staleTime: Infinity
        })
      };
    }
    const observer = observerRef.current.observer;
    const subscribe = (0, _react.useCallback)(onStoreChange => {
      const unsubscribeObserver = observer.subscribe(onStoreChange);
      const unsubscribeLocal = localState.subscribe(key, onStoreChange);
      return () => {
        unsubscribeObserver();
        unsubscribeLocal();
      };
    }, [key, observer]);
    const getSnapshot = (0, _react.useCallback)(() => `${observer.getCurrentResult().fetchStatus}:${observer.getCurrentResult().status}:${observer.getCurrentResult().failureCount}:${observer.getCurrentResult().dataUpdatedAt}:${localState.version(key)}`, [key, observer]);
    (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
    const result = observer.getCurrentResult();
    const local = localState.get(key);
    const meta = result.data ?? undefined;
    return {
      isFetching: result.fetchStatus === 'fetching',
      isFetchingNextPage: local.isFetchingNextPage && result.fetchStatus === 'fetching',
      isFetched: (0, _loadingState.isFetchedResult)(result),
      isPaused: local.isPaused,
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null,
      hasNextPage: meta?.hasNextPage ?? false,
      ids: meta?.ids ?? [],
      resultKind: meta?.resultKind ?? (config.page ? 'many' : 'one')
    };
  };
  const useReader = (scope, enabled, resurrectDestroyed, forceAbsentRefetch) => {
    const key = scope === null ? (0, _serialize.compositeKey)(keyName, 'inactive') : bucketKeyOf(scope);
    const state = useObservedState(key);
    const mountedKey = (0, _react.useRef)(null);
    const forcedRefetch = (0, _react.useRef)(false);
    if (mountedKey.current !== key) forcedRefetch.current = false;
    (0, _react.useEffect)(() => {
      if (scope === null || !enabled) return;
      const client = (0, _configure.getDbQueryClient)();
      const queryKey = queryKeyOf(key);
      const resumeWindow = () => config.resumeStaleTime === undefined ? (0, _configure.getDbRuntimeConfig)().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = () => {
        const window = resumeWindow();
        if (window === null || (0, _queryFreshness.isQueryFresh)(client, queryKey, window)) return false;
        void client.invalidateQueries({
          queryKey,
          refetchType: 'none'
        });
        return true;
      };
      const release = (0, _fetchReaderRegistry.registerActiveFetchReaders)({
        queryKey,
        markResumeStale,
        refetch: () => run(scope, {
          restart: false,
          resurrectDestroyed
        })
      });
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const isFresh = (0, _queryFreshness.isQueryFresh)(client, queryKey, staleTimeOf(key));
      const canRefetch = !firstMount || !state.isFetched || (config.refetchOnMount ?? (0, _configure.getDbRuntimeConfig)().defaults.refetchOnMount) !== false;
      const shouldFetch = firstMount && canRefetch;
      if (shouldFetch && !isFresh && !state.isFetching) {
        void run(scope, {
          restart: false,
          resurrectDestroyed
        });
      }
      if (forceAbsentRefetch && state.isFetched && !state.isFetching && !forcedRefetch.current) {
        forcedRefetch.current = true;
        void run(scope, {
          restart: true,
          resurrectDestroyed
        });
      }
      const unsubscribeOnline = (0, _networkState.subscribeFetchNetwork)(() => {
        if (!(0, _networkState.isFetchNetworkOnline)()) return;
        if (!(0, _queryFreshness.isQueryFresh)(client, queryKey, staleTimeOf(key))) void run(scope, {
          restart: false,
          resurrectDestroyed
        });
      });
      return () => {
        unsubscribeOnline();
        release();
      };
    }, [enabled, forceAbsentRefetch, key, resurrectDestroyed, scope, state.isFetched, state.isFetching]);
    return state;
  };
  const buildResult = (rows, enabled, state, scope) => {
    const hasData = Array.isArray(rows) ? rows.length > 0 : rows !== undefined;
    const phaseInput = {
      isInactive: !enabled && !hasData,
      isFetching: state.isFetching,
      committedRowsDied: false,
      isPaused: state.isPaused,
      retryAttempt: state.retryAttempt,
      hasData,
      isRefreshing: state.isFetching && hasData && !state.isFetchingNextPage,
      isFetchingNextPage: state.isFetchingNextPage,
      isError: state.error !== null,
      hasFetchedData: state.isFetched
    };
    return {
      data: rows,
      loadingState: (0, _loadingState.computeLoadingState)((0, _loadingState.computePhase)(phaseInput), phaseInput),
      error: state.error,
      hasNextPage: config.page ? state.hasNextPage : false,
      isFetchingNextPage: config.page ? state.isFetchingNextPage : false,
      fetchNextPage: () => {
        if (scope !== null && config.page && state.hasNextPage && !state.isFetching) void run(scope, {
          restart: false,
          nextPage: true
        });
      },
      refetch: async () => {
        if (scope !== null) await run(scope, {
          restart: true
        });
      }
    };
  };
  const readDestinationRows = rawScope => {
    const gatedScope = scopeGate(rawScope);
    const scope = gatedScope === null ? null : normalizeScope(gatedScope);
    if (scope === null) return isScopeDestination(config.into) ? [] : undefined;
    if (isScopeDestination(config.into)) return config.into.read(scope);
    const destination = config.into;
    const meta = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(bucketKeyOf(scope)));
    const rows = (meta?.ids ?? []).map(id => destination.find((0, _serialize.parseCompositeKey)(id)[1]));
    return meta?.resultKind === 'many' ? rows : rows[0];
  };
  const useDestinationRows = isScopeDestination(config.into) ? scope => config.into.use(scope) : (_scope, state) => {
    const destination = config.into;
    const rowIds = state.ids.map(id => (0, _serialize.parseCompositeKey)(id)[1]);
    const rows = destination.use.byIds(rowIds).rows;
    return state.resultKind === 'many' ? rows : rows[0];
  };
  const use = (rawScope, options) => {
    const scope = registerScope(scopeGate(rawScope));
    const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const state = useReader(scope, enabled, false, false);
    return buildResult(useDestinationRows(scope, state), enabled, state, scope);
  };
  const handle = {
    read: readDestinationRows,
    use,
    fetch,
    invalidate
  };
  if (isScopeDestination(config.into)) {
    const scopeHandle = config.into;
    const useWindow = (rawScope, options) => {
      const scope = registerScope(scopeGate(rawScope));
      const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
      const state = useReader(scope, enabled, false, false);
      const window = scopeHandle.useWindow(scope, {
        pageSize: options?.pageSize,
        renderKeys: options?.renderKeys,
        require: options?.require,
        keepPrevious: options?.keepPrevious
      });
      const result = buildResult(window.rows, enabled, state, scope);
      const bridge = (0, _pagination.bridgeWindowPagination)(window, result);
      const loadMore = (0, _pagination.useLoadMore)(bridge, {
        debounceMs: options?.loadMoreDebounceMs
      });
      return {
        ...bridge,
        loadMore
      };
    };
    return {
      ...handle,
      useWindow
    };
  }
  const destination = config.into;
  const useRowEnsured = (rawScope, rowId, readOpts) => {
    const scope = registerScope(rawScope);
    const storedData = destination.find(rowId);
    const data = destination.use.find(rowId, readOpts);
    const enabled = data === undefined && rowId != null && (config.enabled?.(scope) ?? true);
    const state = useReader(scope, enabled, true, storedData === undefined);
    const hasData = data !== undefined;
    const phaseInput = {
      isInactive: !enabled && !hasData,
      isFetching: state.isFetching,
      committedRowsDied: false,
      isPaused: state.isPaused,
      retryAttempt: state.retryAttempt,
      hasData,
      isRefreshing: false,
      isFetchingNextPage: false,
      isError: state.error !== null,
      hasFetchedData: state.isFetched
    };
    return {
      data,
      loadingState: (0, _loadingState.computeLoadingState)((0, _loadingState.computePhase)(phaseInput), phaseInput),
      error: state.error,
      refetch: async () => await run(scope, {
        restart: true,
        resurrectDestroyed: true
      })
    };
  };
  return {
    ...handle,
    useRowEnsured
  };
};
exports.defineQuery = defineQuery;
//# sourceMappingURL=defineQuery.js.map