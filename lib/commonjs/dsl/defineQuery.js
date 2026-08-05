"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineQuery = void 0;
var _reactQuery = require("@tanstack/react-query");
var _esToolkit = require("es-toolkit");
var _react = require("react");
var _pagination = require("./pagination.js");
var _loadingState = require("../queries/base/loadingState.js");
var _useObservedQuery = require("../core/fetch/useObservedQuery.js");
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
var _queryPersistence = require("../core/queryPersistence.js");
var _persistedBucket = require("../core/fetch/persistedBucket.js");
var _writePlan = require("./writePlan.js");
var _modelRootPlan = require("./modelRootPlan.js");
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
const nodesOf = (value, connectionExpected) => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (!(0, _normalizeHelpers.isRecord)(value)) throw new Error('defineQuery select/page must return rows, a row, or a connection');
  const connection = value;
  if (connection.nodes) return [...connection.nodes];
  if (connection.edges) return connection.edges.flatMap(edge => edge?.node == null ? [] : [edge.node]);
  if (connectionExpected) return [];
  return [value];
};
const isScopeDestination = into => (0, _normalizeHelpers.isRecord)(into) && (0, _internalHandles.hasInternalScopeHandle)(into);
const isChainMeta = value => (0, _normalizeHelpers.isRecord)(value) && (value.cursor === null || typeof value.cursor === 'string') && typeof value.pages === 'number' && Number.isSafeInteger(value.pages) && value.pages >= 0 && typeof value.hasNextPage === 'boolean' && Array.isArray(value.ids) && value.ids.every(id => typeof id === 'string') && (value.resultKind === 'one' || value.resultKind === 'many');
const isEmptyChain = value => value.ids.length === 0;
/** Largest delay a 32-bit timer holds; anything above it fires on the next tick instead of later. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
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
  const persistenceVersion = config.persistenceVersion ?? 1;
  const persistenceDeclaration = {
    family: `query:${keyName}`,
    persistenceVersion,
    fingerprint: (0, _serialize.stableSerialize)({
      kind: 'query',
      key: keyName,
      persistenceVersion,
      destinationModelId,
      destinationKind: destinationScope ? 'scope' : 'model',
      coverage,
      paged: config.page !== undefined,
      direction: config.direction ?? 'forward',
      cursorVar: config.cursorVar ?? null,
      maxPages: config.maxPages ?? null
    })
  };
  /** Fields react-query cannot express in our vocabulary: offline pause, next-page distinction, and the per-bucket invalidate sequence. */
  const localState = (0, _keyedLocalState.createKeyedLocalState)({
    isPaused: false,
    isFetchingNextPage: false,
    invalidateSeq: 0
  });
  const persistenceRevisionByBucket = new Map();
  const setLocalState = (key, next) => localState.set(key, next);
  (0, _reset.registerKeyedReset)(`query:${keyName}`, () => {
    registeredScopes.clear();
    issuedResetSeqByBucket.clear();
    appliedResetSeqByBucket.clear();
    persistenceRevisionByBucket.clear();
    localState.clear();
  });
  const bucketKeyOf = scope => (0, _serialize.compositeKey)(keyName, (0, _compileDbWhere.buildScopeKey)(scope));
  const queryKeyOf = key => [keyName, key];
  const normalizeScope = scope => destinationScope ? destinationScope.normalize(scope) : scope;
  const registerScope = rawScope => {
    if (rawScope === null) return null;
    const scope = normalizeScope(rawScope);
    destinationScope?.key(scope);
    registeredScopes.set(bucketKeyOf(scope), scope);
    return scope;
  };
  const matchesPartialScope = (scope, partial) => {
    if (!(0, _normalizeHelpers.isNonArrayRecord)(partial)) return Object.is(scope, partial);
    if (!(0, _normalizeHelpers.isNonArrayRecord)(scope)) return false;
    return Object.entries(partial).every(([key, value]) => Object.is(scope[key], value));
  };
  const persistenceWindow = empty => (0, _queryFreshness.persistenceWindowOf)(empty, config.staleTime, config.emptyStaleTime, (0, _configure.getDbRuntimeConfig)().defaults);
  const validateDestination = (scope, meta) => {
    // An empty chain materializes nothing, so there is no destination to require: an empty result
    // never persists a scope snapshot, and demanding one would make every empty record stale.
    if (meta.ids.length === 0) return;
    const parsedIds = meta.ids.map(id => (0, _serialize.parseCompositeKey)(id));
    if (parsedIds.some(parts => parts?.length !== 2 || parts[0] !== destinationModelId)) {
      throw new Error('react-native-dblayer: persisted query row identity does not match its destination');
    }
    if (destinationScope) {
      if (!destinationScope.isResolved(scope)) {
        throw new Error('react-native-dblayer: persisted query scope destination is missing');
      }
      const rowIds = destinationScope.readRows(scope).map(row => destinationScope.normalizeRowId(row));
      if (parsedIds.some(parts => !rowIds.includes(parts[1]))) {
        throw new Error('react-native-dblayer: persisted query scope row is missing');
      }
      return;
    }
    const destination = config.into;
    if (parsedIds.some(parts => destination.find(parts[1]) === undefined)) {
      throw new Error('react-native-dblayer: persisted query model row is missing');
    }
  };
  /**
   * Composite ids this chain still materializes: scope membership for a scope destination, row
   * presence otherwise. The registry calls it only after reading landed non-empty chain ids for
   * this key, so the model branch reads the same cached meta unconditionally.
   */
  const materializedIds = (scope, candidates) => {
    if (destinationScope) {
      return new Set(destinationScope.readRows(scope).map(row => (0, _serialize.compositeKey)(destinationModelId, destinationScope.normalizeRowId(row))));
    }
    const destination = config.into;
    return new Set(candidates.filter(id => destination.find((0, _serialize.parseCompositeKey)(id)[1]) !== undefined));
  };
  /** Every registered chain with the destination it depends on; the registry owns selection and pruning. */
  const materializationChains = function* () {
    for (const scope of registeredScopes.values()) {
      yield {
        queryKey: queryKeyOf(bucketKeyOf(scope)),
        scopeKey: destinationScope ? destinationScope.key(scope) : null,
        materialized: candidates => materializedIds(scope, candidates)
      };
    }
  };
  (0, _fetchReaderRegistry.registerMaterializationReconciler)({
    modelId: destinationModelId,
    chains: materializationChains
  });
  const restore = scope => {
    const identity = bucketKeyOf(scope);
    const cached = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(identity));
    if (cached !== undefined) return cached;
    return (0, _persistedBucket.restorePersistedBucket)({
      declaration: persistenceDeclaration,
      identity,
      queryKey: queryKeyOf(identity),
      validate: candidate => {
        const restoredScope = normalizeScope(candidate.scope);
        if (bucketKeyOf(restoredScope) !== identity || !isChainMeta(candidate.payload)) {
          throw new Error('react-native-dblayer: persisted query identity or metadata is invalid');
        }
        validateDestination(restoredScope, candidate.payload);
        return {
          payload: candidate.payload,
          scope: restoredScope
        };
      },
      cache: meta => meta,
      window: persistenceWindow
    });
  };
  const persist = (scope, meta, invalidationRevision) => {
    const identity = bucketKeyOf(scope);
    (0, _persistedBucket.persistBucket)({
      declaration: persistenceDeclaration,
      identity,
      queryKey: queryKeyOf(identity),
      scope,
      payload: meta,
      empty: isEmptyChain(meta),
      window: persistenceWindow,
      invalidationRevision: invalidationRevision ?? persistenceRevisionByBucket.get(identity) ?? (0, _queryPersistence.readQueryPersistenceRevision)(persistenceDeclaration, identity)
    });
  };
  const pageMetaOf = connection => {
    const info = connection.pageInfo ?? {};
    const backward = config.direction === 'backward';
    return {
      endCursor: config.getCursor ? config.getCursor(connection) : backward ? info.startCursor ?? null : info.endCursor ?? null,
      hasNextPage: backward ? info.hasPreviousPage ?? false : info.hasNextPage ?? false
    };
  };
  const applyResponse = (scope, data, resetOrder, resurrectDestroyed, baseRevision, isCurrent) => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const nodes = nodesOf(selected, config.page !== undefined);
    const destinationModel = destinationScope === null ? (0, _internalHandles.getInternalModelHandle)(config.into) : null;
    const rootOwner = destinationScope ? {
      modelId: destinationModelId,
      planRows: selectedRows => destinationScope.planApply(scope, selectedRows.map(row => ({
        row
      })), coverage, {
        resetOrder
      }),
      planEmpty: () => destinationScope.planApply(scope, [], coverage, {
        resetOrder
      })
    } : {
      modelId: destinationModelId,
      planRows: selectedRows => destinationModel.planRows([...selectedRows], resurrectDestroyed ? {
        origin: 'event'
      } : undefined)
    };
    const root = {
      insert: {
        select: () => nodes
      }
    };
    const ops = (0, _modelRootPlan.compileModelRootPlan)(rootOwner, root, undefined);
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const writePlanCollector = (0, _writePlan.createWritePlanCollector)();
    config.write?.({
      data,
      nodes,
      scope
    }, writePlanCollector.plan);
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const compiledWritePlan = writePlanCollector.compile();
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    ops.push(...compiledWritePlan.writeOps);
    const admittedOps = (0, _writePlan.stampCausalRevision)(ops, baseRevision);
    if (admittedOps.length > 0) (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(admittedOps));
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const invalidationsCurrent = (0, _writePlan.runWritePlanInvalidations)(compiledWritePlan.invalidations, isCurrent, error => (0, _syncError.reportSyncError)(error, {
      source: 'query',
      model: destinationModelId,
      key: keyName
    }, 'defineQuery'));
    if (!invalidationsCurrent) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const committedRows = nodes;
    const normalizeRowId = destinationScope ? row => destinationScope.normalizeRowId(row) : row => destinationModel.normalizeRowId(row);
    const ids = committedRows.map(row => (0, _serialize.compositeKey)(destinationModelId, normalizeRowId(row)));
    const meta = config.page ? pageMetaOf(selected) : {
      endCursor: null,
      hasNextPage: false
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
    const baseRevision = (0, _configure.getApplyRuntime)().currentEpoch();
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
    const result = applyResponse(scope, data, reset, resurrectDestroyed, baseRevision, context.isCurrent);
    const previous = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(key));
    const previousPages = previous?.pages ?? 0;
    const pages = config.page ? reset ? 1 : previousPages + 1 : 1;
    /** maxPages is a hard ceiling: once reached, the chain reports exhaustion and fetchNextPage stops issuing requests. */
    const hasNextPage = result.meta.hasNextPage && (config.maxPages === undefined || pages < config.maxPages);
    return {
      cursor: config.page && hasNextPage ? result.meta.endCursor : null,
      pages,
      hasNextPage,
      ids: reset ? result.ids : (0, _esToolkit.union)(previous.ids, result.ids),
      resultKind: result.resultKind
    };
  };
  /**
   * The declared window doubles as the refresh cadence while a reader watches. A window only
   * consulted when a reader mounts cannot repair a feed whose live channel died under a screen the
   * user never left, which is the case the window is declared for. `Infinity` and `0` opt out: one
   * declares data that never ages, the other data whose every read is already a fetch.
   */
  const refreshIntervalOf = key => {
    const window = staleTimeOf(key);
    // A window past the platform timer ceiling is not a long schedule - the timer silently collapses
    // to the next tick and the screen starts polling the transport. Such a window declares data that
    // does not age, which is the same answer as `Infinity` and `0`: no schedule.
    return window > 0 && window <= MAX_TIMER_DELAY_MS ? window : false;
  };
  const staleTimeOf = key => {
    const meta = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(key)) ?? undefined;
    const defaults = (0, _configure.getDbRuntimeConfig)().defaults;
    return meta !== undefined && isEmptyChain(meta) && ((0, _queryFreshness.resolveStaleTime)(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null ? (0, _queryFreshness.resolveStaleTime)(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime : (0, _queryFreshness.resolveStaleTime)(config.staleTime, defaults) ?? defaults.staleTime ?? 0;
  };
  const engineStaleTimeOf = key => {
    const window = staleTimeOf(key);
    return window > MAX_TIMER_DELAY_MS ? Infinity : window;
  };
  const run = async (scope, options) => {
    (0, _queryFreshness.resolveStaleTime)(config.staleTime, (0, _configure.getDbRuntimeConfig)().defaults);
    (0, _queryFreshness.resolveStaleTime)(config.emptyStaleTime, (0, _configure.getDbRuntimeConfig)().defaults);
    if (config.enabled && !config.enabled(scope)) return;
    const key = bucketKeyOf(scope);
    const client = (0, _configure.getDbQueryClient)();
    const queryKey = queryKeyOf(key);
    const restored = restore(scope);
    if (!(0, _networkState.isFetchNetworkOnline)()) {
      setLocalState(key, {
        isPaused: true
      });
      if (restored === undefined && options.propagateFailure) throw (0, _networkState.createOfflineFetchError)();
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
    const invalidateSeqAtStart = localState.get(key).invalidateSeq;
    const persistenceRevisionAtStart = (0, _queryPersistence.readQueryPersistenceRevision)(persistenceDeclaration, key);
    try {
      const meta = await client.fetchQuery({
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
              cursor: null,
              pages: 0,
              hasNextPage: false,
              ids: [],
              resultKind: 'one'
            };
          }
          return meta;
        },
        staleTime: options.restart || options.nextPage ? 0 : engineStaleTimeOf(key)
      });
      if (!generationFence.isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
      if (localState.get(key).invalidateSeq !== invalidateSeqAtStart) {
        // An invalidate landed while this fetch was in flight. The response predates it, so it
        // cannot satisfy it: restore the invalidated mark the landing cleared and run once more.
        await client.invalidateQueries({
          queryKey,
          exact: true,
          refetchType: 'none'
        });
        if (!generationFence.isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
        await run(scope, {
          restart: false,
          resurrectDestroyed: options.resurrectDestroyed,
          propagateFailure: options.propagateFailure
        });
        return;
      }
      if (meta !== null) persist(scope, meta, persistenceRevisionAtStart);
      if (!generationFence.isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
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
        const cached = client.getQueryData(queryKey);
        if (cached === undefined && options.propagateFailure) throw (0, _networkState.createOfflineFetchError)();
        return;
      }
      setLocalState(key, {
        isFetchingNextPage: false
      });
      if (!options.restart && client.getQueryData(queryKey) !== undefined) return;
      if (options.propagateFailure) throw error instanceof Error ? error : new Error(String(error));
      return;
    }
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
      restart: false,
      propagateFailure: true
    });
  };
  const refresh = async rawScope => {
    const scope = registerScope(scopeGate(rawScope));
    if (scope === null) return;
    await run(scope, {
      restart: true,
      propagateFailure: true
    });
  };
  const invalidateRegisteredScope = registered => {
    const client = (0, _configure.getDbQueryClient)();
    const key = bucketKeyOf(registered);
    const queryKey = queryKeyOf(key);
    // The sequence lets an in-flight run see that this invalidate outranks its response.
    setLocalState(key, {
      invalidateSeq: localState.get(key).invalidateSeq + 1
    });
    // Invalidation is lazy: freshness drops for everyone, but only mounted readers refetch now.
    void client.invalidateQueries({
      queryKey,
      refetchType: 'none'
    }).then(() => {
      (0, _fetchReaderRegistry.refetchActiveFetchReaders)(queryKey);
    });
  };
  const invalidateMatching = partial => {
    (0, _queryPersistence.invalidatePersistedQuery)(persistenceDeclaration, record => {
      try {
        const scope = normalizeScope(record.scope);
        destinationScope?.key(scope);
        return matchesPartialScope(scope, partial);
      } catch {
        return false;
      }
    });
    for (const registered of registeredScopes.values()) {
      if (!matchesPartialScope(registered, partial)) continue;
      invalidateRegisteredScope(registered);
    }
  };
  const invalidateAll = () => {
    (0, _queryPersistence.invalidatePersistedQuery)(persistenceDeclaration, () => true);
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
        return true;
      }
      if (destinationScope && !destinationScope.isComplete(scope)) return false;
      invalidateMatching(normalizeScope(scope));
      return true;
    });
  }
  const useObservedState = (key, scope, enabled, resurrectDestroyed) => {
    const client = (0, _configure.getDbQueryClient)();
    // One entry point for every automatic fetch of this bucket: the declared window is the
    // observer's real `staleTime`, so first load, mounting on stale data, reconnecting and the
    // interval are all decided by React Query. `run` stays for what a caller asks for by name -
    // `fetch`, `refresh`, next page - where the caller owns the outcome and the error.
    const observerOptions = {
      queryKey: queryKeyOf(key),
      enabled: enabled && scope !== null,
      staleTime: engineStaleTimeOf(key),
      // The scheduled path pauses offline and resumes itself on reconnect, which is what a reader
      // watching a screen needs. The imperative path keeps the runtime default: a caller awaiting
      // `fetch()` must get an offline error rather than a promise that waits for the network.
      networkMode: 'online',
      refetchOnMount: config.refetchOnMount ?? (0, _configure.getDbRuntimeConfig)().defaults.refetchOnMount ?? true,
      refetchOnReconnect: true,
      refetchIntervalInBackground: false,
      refetchInterval: () => refreshIntervalOf(key),
      queryFn: async () => {
        const current = () => client.getQueryData(queryKeyOf(key)) ?? null;
        const activeScope = scope;
        const fence = (0, _runtimeGeneration.createGenerationFence)();
        let issuedAt = localState.get(key).invalidateSeq;
        let persistenceRevision = (0, _queryPersistence.readQueryPersistenceRevision)(persistenceDeclaration, key);
        let meta = await execute(activeScope, key, resurrectDestroyed, {
          cursor: null,
          isCurrent: fence.isCurrent
        });
        // An invalidate that landed while this fetch was in flight outranks the response: it was
        // issued after the request left, so the answer predates it and cannot satisfy it. Reading
        // again inside this fetch keeps the debt with the fetch that owes it - a follow-up scheduled
        // outside would dedupe straight back into the fetch it is meant to supersede.
        while (fence.isCurrent() && localState.get(key).invalidateSeq !== issuedAt) {
          issuedAt = localState.get(key).invalidateSeq;
          persistenceRevision = (0, _queryPersistence.readQueryPersistenceRevision)(persistenceDeclaration, key);
          meta = (await execute(activeScope, key, resurrectDestroyed, {
            cursor: null,
            isCurrent: fence.isCurrent
          })) ?? meta;
        }
        if (fence.isCurrent()) persistenceRevisionByBucket.set(key, persistenceRevision);
        return meta ?? current();
      }
    };
    const result = (0, _useObservedQuery.useObservedQuery)(key, observerOptions, `${observerOptions.enabled}:${String(refreshIntervalOf(key))}`, localState);
    const local = localState.get(key);
    const meta = result.data ?? undefined;
    return {
      isFetching: result.fetchStatus === 'fetching',
      isFetchingNextPage: local.isFetchingNextPage && result.fetchStatus === 'fetching',
      isFetched: (0, _loadingState.isFetchedResult)(result),
      isPaused: local.isPaused || result.fetchStatus === 'paused',
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null,
      hasNextPage: meta?.hasNextPage ?? false,
      ids: meta?.ids ?? [],
      resultKind: meta?.resultKind ?? (config.page ? 'many' : 'one'),
      dataUpdatedAt: result.dataUpdatedAt
    };
  };
  const useReader = (scope, enabled, resurrectDestroyed, forceAbsentRefetch) => {
    const key = scope === null ? (0, _serialize.compositeKey)(keyName, 'inactive') : bucketKeyOf(scope);
    const state = useObservedState(key, scope, enabled, resurrectDestroyed);
    const mountedKey = (0, _react.useRef)(null);
    const forcedRefetch = (0, _react.useRef)(false);
    if (mountedKey.current !== key) forcedRefetch.current = false;
    // Freshness has to survive a restart whichever path fetched, and the scheduled refresh lands
    // through the observer rather than through `run`. Following the landing timestamp records both.
    (0, _react.useEffect)(() => {
      if (scope === null || state.dataUpdatedAt === 0) return;
      const meta = (0, _configure.getDbQueryClient)().getQueryData(queryKeyOf(key));
      if (meta !== undefined) persist(scope, meta);
    }, [key, scope, state.dataUpdatedAt]);
    (0, _react.useEffect)(() => {
      if (scope === null || !enabled) return;
      const client = (0, _configure.getDbQueryClient)();
      const queryKey = queryKeyOf(key);
      const resumeWindow = () => config.resumeStaleTime === undefined ? (0, _configure.getDbRuntimeConfig)().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = () => {
        const window = resumeWindow();
        if (window === null || (0, _queryFreshness.isQueryFresh)(client, queryKey, window)) return false;
        setLocalState(key, {
          invalidateSeq: localState.get(key).invalidateSeq + 1
        });
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
      mountedKey.current = key;
      if (forceAbsentRefetch && state.isFetched && !state.isFetching && !forcedRefetch.current) {
        forcedRefetch.current = true;
        void run(scope, {
          restart: true,
          resurrectDestroyed
        });
      }
      return release;
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
      refresh: async () => {
        if (scope !== null) await run(scope, {
          restart: true
        });
      }
    };
  };
  const readDestinationRows = rawScope => {
    const gatedScope = scopeGate(rawScope);
    const scope = registerScope(gatedScope);
    if (scope === null) return isScopeDestination(config.into) ? [] : undefined;
    restore(scope);
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
    if (scope !== null) restore(scope);
    const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const state = useReader(scope, enabled, false, false);
    return buildResult(useDestinationRows(scope, state), enabled, state, scope);
  };
  const handle = {
    read: readDestinationRows,
    use,
    fetch,
    refresh,
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
      refresh: async () => await run(scope, {
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