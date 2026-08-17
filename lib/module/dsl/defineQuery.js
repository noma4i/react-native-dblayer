"use strict";

import { CancelledError } from '@tanstack/react-query';
import { union } from 'es-toolkit';
import { useEffect, useRef } from 'react';
import { bridgeWindowPagination, useLoadMore } from "./pagination.js";
import { computeLoadingState, computePhase, isFetchedResult } from "../queries/base/loadingState.js";
import { useObservedQuery } from "../core/fetch/useObservedQuery.js";
import { createCommitEnvelope } from "../core/apply/commitEnvelope.js";
import { buildScopeKey } from "../core/compileDbWhere.js";
import { compositeKey, parseCompositeKey, stableSerialize } from "../core/serialize.js";
import { registerModelInvalidation } from "../core/invalidationRegistry.js";
import { isNonArrayRecord, isRecord } from "../utils/normalizeHelpers.js";
import { getApplyRuntime, getDbQueryClient, getDbRuntimeConfig } from "./configure.js";
import { responseDataOrThrow } from "../core/transport.js";
import { getInternalModelHandle, getInternalScopeHandle, hasInternalScopeHandle } from "../core/internalHandles.js";
import { refetchActiveFetchReaders, registerActiveFetchReaders, registerMaterializationReconciler } from "../core/fetch/fetchReaderRegistry.js";
import { createOfflineFetchError, isFetchNetworkOnline } from "../core/fetch/networkState.js";
import { isQueryFresh, persistenceWindowOf, resolveStaleTime } from "../core/fetch/queryFreshness.js";
import { registerKeyedReset, registerReset } from "../core/reset.js";
import { createKeyedLocalState } from "../core/fetch/keyedLocalState.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { fromNodes } from "../queries/base/connection.js";
import { reportSyncError } from "../core/syncError.js";
import { invalidatePersistedQuery, readQueryPersistenceRevision } from "../core/queryPersistence.js";
import { persistBucket, restorePersistedBucket } from "../core/fetch/persistedBucket.js";
import { createWritePlanCollector, runWritePlanInvalidations, stampCausalRevision } from "./writePlan.js";
import { compileModelRootPlan } from "./modelRootPlan.js";
const issuedResetSeqByBucket = new Map();
const appliedResetSeqByBucket = new Map();
registerReset(() => {
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
  if (!isRecord(value)) throw new Error('defineQuery select/page must return rows, a row, or a connection');
  const connection = value;
  if (connection.nodes) return [...connection.nodes];
  if (connection.edges) return connection.edges.flatMap(edge => edge?.node == null ? [] : [edge.node]);
  if (connectionExpected) return [];
  return [value];
};
const isScopeDestination = into => isRecord(into) && hasInternalScopeHandle(into);
const isChainMeta = value => isRecord(value) && (value.cursor === null || typeof value.cursor === 'string') && typeof value.pages === 'number' && Number.isSafeInteger(value.pages) && value.pages >= 0 && typeof value.hasNextPage === 'boolean' && Array.isArray(value.ids) && value.ids.every(id => typeof id === 'string') && (value.resultKind === 'one' || value.resultKind === 'many');
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
        nodes: fromNodes(value),
        pageInfo: value?.pageInfo
      };
    }
  };
};
/** Define a coordinator-owned GraphQL query: react-query drives freshness/single-flight/retry, results land through the store's write seams. */
export const defineQuery = rawConfig => {
  const config = normalizeQueryConfig(rawConfig);
  const keyName = operationKey(config.document, config.key);
  const registeredScopes = new Map();
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const destinationModelId = config.into.modelId;
  const destinationScope = isScopeDestination(config.into) ? getInternalScopeHandle(config.into) : null;
  const persistenceVersion = config.persistenceVersion ?? 1;
  const persistenceDeclaration = {
    family: `query:${keyName}`,
    persistenceVersion,
    fingerprint: stableSerialize({
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
  const localState = createKeyedLocalState({
    isPaused: false,
    isFetchingNextPage: false,
    invalidateSeq: 0
  });
  const persistenceRevisionByBucket = new Map();
  const setLocalState = (key, next) => localState.set(key, next);
  registerKeyedReset(`query:${keyName}`, () => {
    registeredScopes.clear();
    issuedResetSeqByBucket.clear();
    appliedResetSeqByBucket.clear();
    persistenceRevisionByBucket.clear();
    localState.clear();
  });
  const bucketKeyOf = scope => compositeKey(keyName, buildScopeKey(scope));
  const queryKeyOf = key => [keyName, key];
  const normalizeScope = scope => destinationScope ? destinationScope.normalize(scope) : scope;
  // One scope object per bucket key: reader effects keyed on the scope run once per key, not once per render.
  const registerScope = rawScope => {
    if (rawScope === null) return null;
    const scope = normalizeScope(rawScope);
    destinationScope?.key(scope);
    const bucketKey = bucketKeyOf(scope);
    const registered = registeredScopes.get(bucketKey);
    if (registered !== undefined) return registered;
    registeredScopes.set(bucketKey, scope);
    return scope;
  };
  const matchesPartialScope = (scope, partial) => {
    if (!isNonArrayRecord(partial)) return Object.is(scope, partial);
    if (!isNonArrayRecord(scope)) return false;
    return Object.entries(partial).every(([key, value]) => Object.is(scope[key], value));
  };
  const persistenceWindow = empty => persistenceWindowOf(empty, config.staleTime, config.emptyStaleTime, getDbRuntimeConfig().defaults);
  const validateDestinationIdentity = meta => {
    const parsedIds = meta.ids.map(id => parseCompositeKey(id));
    if (parsedIds.some(parts => parts?.length !== 2 || parts[0] !== destinationModelId)) {
      throw new Error('react-native-dblayer: persisted query row identity does not match its destination');
    }
  };
  /**
   * Composite ids this chain still materializes: scope membership for a scope destination, row
   * presence otherwise. The registry calls it only after reading landed non-empty chain ids for
   * this key, so the model branch reads the same cached meta unconditionally.
   */
  const materializedIds = (scope, candidates) => {
    if (destinationScope) {
      return new Set(destinationScope.readRows(scope).map(row => compositeKey(destinationModelId, destinationScope.normalizeRowId(row))));
    }
    const destination = config.into;
    return new Set(candidates.filter(id => destination.find(parseCompositeKey(id)[1]) !== undefined));
  };
  const persist = (scope, meta, invalidationRevision, onError) => {
    const identity = bucketKeyOf(scope);
    const queryState = getDbQueryClient().getQueryState(queryKeyOf(identity));
    persistBucket({
      declaration: persistenceDeclaration,
      identity,
      scope,
      payload: meta,
      empty: isEmptyChain(meta),
      dataUpdatedAt: queryState.dataUpdatedAt,
      invalidated: queryState.isInvalidated,
      window: persistenceWindow,
      invalidationRevision: invalidationRevision ?? persistenceRevisionByBucket.get(identity) ?? readQueryPersistenceRevision(persistenceDeclaration, identity),
      onError
    });
  };
  const reportPersistenceError = error => {
    reportSyncError(error, {
      source: 'query',
      model: destinationModelId,
      key: keyName
    }, 'defineQuery');
  };
  /** Every registered chain with the destination it depends on; the registry owns selection and pruning. */
  const materializationChains = function* () {
    for (const scope of registeredScopes.values()) {
      yield {
        queryKey: queryKeyOf(bucketKeyOf(scope)),
        scopeKey: destinationScope ? destinationScope.key(scope) : null,
        materialized: candidates => materializedIds(scope, candidates),
        persistMaterialization: ids => {
          const meta = getDbQueryClient().getQueryData(queryKeyOf(bucketKeyOf(scope)));
          persist(scope, {
            ...meta,
            ids: [...ids]
          }, undefined, reportPersistenceError);
        }
      };
    }
  };
  registerMaterializationReconciler({
    modelId: destinationModelId,
    chains: materializationChains
  });
  const restore = scope => {
    const identity = bucketKeyOf(scope);
    const cached = getDbQueryClient().getQueryData(queryKeyOf(identity));
    if (cached !== undefined) return cached;
    return restorePersistedBucket({
      declaration: persistenceDeclaration,
      identity,
      queryKey: queryKeyOf(identity),
      validate: candidate => {
        const restoredScope = normalizeScope(candidate.scope);
        if (bucketKeyOf(restoredScope) !== identity || !isChainMeta(candidate.payload)) {
          throw new Error('react-native-dblayer: persisted query identity or metadata is invalid');
        }
        validateDestinationIdentity(candidate.payload);
        return {
          payload: candidate.payload,
          scope: restoredScope
        };
      },
      reconcile: record => {
        const materialized = materializedIds(record.scope, record.payload.ids);
        const ids = record.payload.ids.filter(id => materialized.has(id));
        if (ids.length === record.payload.ids.length) return record;
        return {
          ...record,
          payload: {
            ...record.payload,
            ids
          },
          empty: ids.length === 0,
          invalidated: true
        };
      },
      onRewriteError: reportPersistenceError,
      cache: meta => meta,
      window: persistenceWindow
    });
  };
  const landingError = message => reportSyncError(new Error(message), {
    source: 'query',
    model: destinationModelId,
    key: keyName
  }, 'defineQuery');
  /**
   * Landing gate for a paged response, judged BEFORE the page commits: a page without applicable
   * pageInfo, or one claiming a next page without a cursor, cannot move the chain. Refusing it here
   * keeps the accumulated chain and its memberships intact instead of landing silent exhaustion.
   */
  const pageMetaOf = connection => {
    const info = connection?.pageInfo;
    if (!isRecord(info)) throw landingError('react-native-dblayer: connection landing has no usable pageInfo');
    const backward = config.direction === 'backward';
    const meta = {
      endCursor: config.getCursor ? config.getCursor(connection) : backward ? info.startCursor ?? null : info.endCursor ?? null,
      hasNextPage: backward ? info.hasPreviousPage ?? false : info.hasNextPage ?? false
    };
    if (meta.hasNextPage && meta.endCursor == null) throw landingError('react-native-dblayer: connection landing claims hasNextPage without a cursor');
    return meta;
  };
  const applyResponse = (scope, data, resetOrder, resurrectDestroyed, baseRevision, isCurrent) => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const rawNodes = nodesOf(selected, config.page !== undefined);
    const pageMeta = config.page ? pageMetaOf(selected) : {
      endCursor: null,
      hasNextPage: false
    };
    const destinationModel = destinationScope === null ? getInternalModelHandle(config.into) : null;
    // Landing admission judges each node ONCE: a malformed node is quarantined as
    // plan-row-rejected and dropped here, so it can neither crash the landing nor take its
    // valid siblings down with it. The chain below is built from the same admitted set.
    const admitRowId = destinationScope ? row => destinationScope.admitRowId(row) : row => destinationModel.admitRowId(row);
    const admitted = rawNodes.map(row => ({
      row,
      id: admitRowId(row)
    })).filter(entry => entry.id !== undefined);
    const nodes = admitted.map(entry => entry.row);
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
    const ops = compileModelRootPlan(rootOwner, root, undefined);
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const writePlanCollector = createWritePlanCollector();
    config.write?.({
      data,
      nodes,
      scope
    }, writePlanCollector.plan);
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const compiledWritePlan = writePlanCollector.compile();
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    ops.push(...compiledWritePlan.writeOps);
    const admittedOps = stampCausalRevision(ops, baseRevision);
    if (admittedOps.length > 0) getApplyRuntime().commit(createCommitEnvelope(admittedOps));
    if (!isCurrent()) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const invalidationsCurrent = runWritePlanInvalidations(compiledWritePlan.invalidations, isCurrent, error => reportSyncError(error, {
      source: 'query',
      model: destinationModelId,
      key: keyName
    }, 'defineQuery'));
    if (!invalidationsCurrent) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
    const ids = admitted.map(entry => compositeKey(destinationModelId, entry.id));
    return {
      meta: pageMeta,
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
    const scopeKey = buildScopeKey(scope);
    // The supersession gate carries the declaration identity: 2 declarations landing into one
    // scope destination race their OWN resets, a reset of one must not swallow the other's landing.
    const guardKey = isScopeDestination(config.into) ? compositeKey(keyName, destinationModelId, getInternalScopeHandle(config.into).key(scope)) : compositeKey(keyName, scopeKey);
    const reset = context.cursor === null;
    const issued = reset ? (issuedResetSeqByBucket.get(guardKey) ?? 0) + 1 : issuedResetSeqByBucket.get(guardKey);
    if (reset) issuedResetSeqByBucket.set(guardKey, issued);
    let data;
    const baseRevision = getApplyRuntime().currentEpoch();
    try {
      data = responseDataOrThrow(await getDbRuntimeConfig().transport.query({
        query: config.document,
        variables: variables
      }));
    } catch (error) {
      if (!context.isCurrent()) throw error;
      reportSyncError(error, {
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
    const previous = getDbQueryClient().getQueryData(queryKeyOf(key));
    const previousPages = previous?.pages ?? 0;
    const pages = config.page ? reset ? 1 : previousPages + 1 : 1;
    /** maxPages is a hard ceiling: once reached, the chain reports exhaustion and fetchNextPage stops issuing requests. */
    const hasNextPage = result.meta.hasNextPage && (config.maxPages === undefined || pages < config.maxPages);
    return {
      cursor: config.page && hasNextPage ? result.meta.endCursor : null,
      pages,
      hasNextPage,
      ids: reset ? result.ids : union(previous.ids, result.ids),
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
    const meta = getDbQueryClient().getQueryData(queryKeyOf(key)) ?? undefined;
    const defaults = getDbRuntimeConfig().defaults;
    return meta !== undefined && isEmptyChain(meta) && (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null ? resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime : resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0;
  };
  const engineStaleTimeOf = key => {
    const window = staleTimeOf(key);
    return window > MAX_TIMER_DELAY_MS ? Infinity : window;
  };
  const run = async (scope, options) => {
    resolveStaleTime(config.staleTime, getDbRuntimeConfig().defaults);
    resolveStaleTime(config.emptyStaleTime, getDbRuntimeConfig().defaults);
    if (config.enabled && !config.enabled(scope)) return;
    const key = bucketKeyOf(scope);
    const client = getDbQueryClient();
    const queryKey = queryKeyOf(key);
    const restored = restore(scope);
    if (!isFetchNetworkOnline()) {
      setLocalState(key, {
        isPaused: true
      });
      if (restored === undefined && options.propagateFailure) throw createOfflineFetchError();
      return;
    }
    // A next page exists only while the live chain carries a cursor: a request from a render that
    // predates the last landing must not run as a first-page landing.
    if (options.nextPage && (client.getQueryData(queryKey)?.cursor ?? null) === null) return;
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({
      queryKey
    });
    setLocalState(key, {
      isPaused: false,
      isFetchingNextPage: options.nextPage === true
    });
    const generationFence = createGenerationFence();
    const invalidateSeqAtStart = localState.get(key).invalidateSeq;
    const persistenceRevisionAtStart = readQueryPersistenceRevision(persistenceDeclaration, key);
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
            const cached = client.getQueryData(queryKey);
            // A superseded flight owns no result. Without cached meta there is nothing truthful to
            // return: fabricating a fresh-empty chain would stamp data that never landed. Cancel.
            if (cached === undefined) throw new CancelledError();
            return cached;
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
      if (error instanceof CancelledError) return;
      if (!isFetchNetworkOnline()) {
        setLocalState(key, {
          isPaused: true,
          isFetchingNextPage: false
        });
        const cached = client.getQueryData(queryKey);
        if (cached === undefined && options.propagateFailure) throw createOfflineFetchError();
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
    const client = getDbQueryClient();
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
      refetchActiveFetchReaders(queryKey);
    });
  };
  const invalidateMatching = partial => {
    invalidatePersistedQuery(persistenceDeclaration, record => {
      try {
        const scope = normalizeScope(record.scope);
        destinationScope?.key(scope);
        return matchesPartialScope(scope, partial);
      } catch (error) {
        // A persisted scope the matcher cannot even read must not dodge its family invalidation:
        // a throw is a match, and the rejected record is reported.
        reportSyncError(error, {
          source: 'query',
          model: destinationModelId,
          key: keyName
        }, 'defineQuery');
        return true;
      }
    });
    for (const registered of registeredScopes.values()) {
      if (!matchesPartialScope(registered, partial)) continue;
      invalidateRegisteredScope(registered);
    }
  };
  const invalidateAll = () => {
    invalidatePersistedQuery(persistenceDeclaration, () => true);
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
    registerModelInvalidation(destinationModelId, keyName, scope => {
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
    const client = getDbQueryClient();
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
      refetchOnMount: config.refetchOnMount ?? getDbRuntimeConfig().defaults.refetchOnMount ?? true,
      refetchOnReconnect: true,
      refetchIntervalInBackground: false,
      refetchInterval: () => refreshIntervalOf(key),
      queryFn: async () => {
        const current = () => client.getQueryData(queryKeyOf(key)) ?? null;
        const activeScope = scope;
        const fence = createGenerationFence();
        let issuedAt = localState.get(key).invalidateSeq;
        let persistenceRevision = readQueryPersistenceRevision(persistenceDeclaration, key);
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
          persistenceRevision = readQueryPersistenceRevision(persistenceDeclaration, key);
          meta = (await execute(activeScope, key, resurrectDestroyed, {
            cursor: null,
            isCurrent: fence.isCurrent
          })) ?? meta;
        }
        if (fence.isCurrent()) persistenceRevisionByBucket.set(key, persistenceRevision);
        return meta ?? current();
      }
    };
    const result = useObservedQuery(key, observerOptions, `${observerOptions.enabled}:${String(refreshIntervalOf(key))}`, localState);
    const local = localState.get(key);
    const meta = result.data ?? undefined;
    return {
      isFetching: result.fetchStatus === 'fetching',
      isFetchingNextPage: local.isFetchingNextPage && result.fetchStatus === 'fetching',
      isFetched: isFetchedResult(result),
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
    const key = scope === null ? compositeKey(keyName, 'inactive') : bucketKeyOf(scope);
    const state = useObservedState(key, scope, enabled, resurrectDestroyed);
    const mountedKey = useRef(null);
    const forcedRefetch = useRef(false);
    if (mountedKey.current !== key) forcedRefetch.current = false;
    // Freshness has to survive a restart whichever path fetched, and the scheduled refresh lands
    // through the observer rather than through `run`. Following the landing timestamp records both.
    useEffect(() => {
      if (scope === null || state.dataUpdatedAt === 0) return;
      const meta = getDbQueryClient().getQueryData(queryKeyOf(key));
      if (meta !== undefined) persist(scope, meta);
    }, [key, scope, state.dataUpdatedAt]);
    useEffect(() => {
      if (scope === null || !enabled) return;
      const client = getDbQueryClient();
      const queryKey = queryKeyOf(key);
      const resumeWindow = () => config.resumeStaleTime === undefined ? getDbRuntimeConfig().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = () => {
        const window = resumeWindow();
        if (window === null || isQueryFresh(client, queryKey, window)) return false;
        setLocalState(key, {
          invalidateSeq: localState.get(key).invalidateSeq + 1
        });
        void client.invalidateQueries({
          queryKey,
          refetchType: 'none'
        });
        return true;
      };
      const release = registerActiveFetchReaders({
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
      loadingState: computeLoadingState(computePhase(phaseInput), phaseInput),
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
    const meta = getDbQueryClient().getQueryData(queryKeyOf(bucketKeyOf(scope)));
    // A landed id whose row died since is not a hole in the result: readers get survivors only.
    const rows = (meta?.ids ?? []).flatMap(id => {
      const row = destination.find(parseCompositeKey(id)[1]);
      return row === undefined ? [] : [row];
    });
    return meta?.resultKind === 'many' ? rows : rows[0];
  };
  const useDestinationRows = isScopeDestination(config.into) ? scope => config.into.use(scope) : (_scope, state) => {
    const destination = config.into;
    const rowIds = state.ids.map(id => parseCompositeKey(id)[1]);
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
      const bridge = bridgeWindowPagination(window, result);
      const loadMore = useLoadMore(bridge, {
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
      loadingState: computeLoadingState(computePhase(phaseInput), phaseInput),
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
//# sourceMappingURL=defineQuery.js.map