"use strict";

import { CancelledError, QueryObserver } from '@tanstack/react-query';
import { union } from 'es-toolkit';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { bridgeWindowPagination, useLoadMore } from "./pagination.js";
import { computeLoadingState, computePhase, isFetchedResult } from "../queries/base/loadingState.js";
import { createCommitEnvelope } from "../core/apply/commitEnvelope.js";
import { buildScopeKey } from "../core/compileDbWhere.js";
import { compositeKey, parseCompositeKey } from "../core/serialize.js";
import { registerModelInvalidation } from "../core/invalidationRegistry.js";
import { isNonArrayRecord, isRecord } from "../utils/normalizeHelpers.js";
import { getApplyRuntime, getDbQueryClient, getDbRuntimeConfig, getRuntimeGeneration } from "./configure.js";
import { responseDataOrThrow } from "../core/transport.js";
import { getInternalModelHandle, getInternalScopeHandle, hasInternalScopeHandle } from "../core/internalHandles.js";
import { refetchActiveFetchReaders, registerActiveFetchReaders } from "../core/fetch/fetchReaderRegistry.js";
import { isFetchNetworkOnline, subscribeFetchNetwork } from "../core/fetch/networkState.js";
import { isQueryFresh, resolveStaleTime } from "../core/fetch/queryFreshness.js";
import { registerKeyedReset, registerReset } from "../core/reset.js";
import { createKeyedLocalState } from "../core/fetch/keyedLocalState.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { fromNodes } from "../queries/base/connection.js";
import { reportSyncError } from "../core/syncError.js";
/**
 * Create one extract sink only when a row exists; pair with the `{ into, rows }` extract contract.
 *
 * @param into Extract destination.
 * @param row Optional source row.
 * @returns One extract sink, or an empty list.
 */
export const intoIf = (into, row) => row == null ? [] : [{
  into,
  rows: [row]
}];
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
const nodesOf = value => {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return value == null ? [] : [value];
  const connection = value;
  if (connection.nodes) return [...connection.nodes];
  if (connection.edges) return connection.edges.flatMap(edge => edge?.node == null ? [] : [edge.node]);
  return [value];
};
const isScopeDestination = into => isRecord(into) && hasInternalScopeHandle(into);
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
  const destinationModelId = config.into.modelId ?? keyName;
  /** Fields react-query cannot express in our vocabulary: offline pause and next-page distinction. */
  const localState = createKeyedLocalState({
    isPaused: false,
    isFetchingNextPage: false
  });
  const setLocalState = (key, next) => localState.set(key, next);
  registerKeyedReset(`query:${keyName}`, () => {
    registeredScopes.clear();
    issuedResetSeqByBucket.clear();
    appliedResetSeqByBucket.clear();
    localState.clear();
  });
  const bucketKeyOf = scope => compositeKey(keyName, buildScopeKey(scope));
  const queryKeyOf = key => [keyName, key];
  const registerScope = scope => {
    if (scope === null) return false;
    if (isScopeDestination(config.into)) getInternalScopeHandle(config.into).key(scope);
    registeredScopes.set(buildScopeKey(scope), scope);
    return true;
  };
  const matchesPartialScope = (scope, partial) => {
    if (!isNonArrayRecord(partial)) return Object.is(scope, partial);
    if (!isNonArrayRecord(scope)) return false;
    return Object.entries(partial).every(([key, value]) => Object.is(scope[key], value));
  };
  const pageMetaOf = connection => {
    if (!connection) return {
      endCursor: null,
      hasNextPage: false,
      count: 0
    };
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
    if (isScopeDestination(config.into)) ops.push(...getInternalScopeHandle(config.into).planApply(scope, rows, coverage, {
      resetOrder
    }));else ops.push(...getInternalModelHandle(config.into).planRows(nodes, resurrectDestroyed ? {
      origin: 'event'
    } : undefined));
    for (const sink of config.extract?.({
      data,
      nodes
    }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
    if (ops.length > 0) getApplyRuntime().commit(createCommitEnvelope(ops));
    const committedRows = isScopeDestination(config.into) ? rows.map(entry => entry.row) : nodes;
    const ids = committedRows.flatMap(row => isRecord(row) && row.id != null ? [compositeKey(destinationModelId, String(row.id))] : []);
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
    const scopeKey = buildScopeKey(scope);
    const guardKey = isScopeDestination(config.into) ? compositeKey(destinationModelId, getInternalScopeHandle(config.into).key(scope)) : compositeKey(keyName, scopeKey);
    const reset = context.cursor === null;
    const issued = reset ? (issuedResetSeqByBucket.get(guardKey) ?? 0) + 1 : issuedResetSeqByBucket.get(guardKey) ?? 0;
    if (reset) issuedResetSeqByBucket.set(guardKey, issued);
    let data;
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
    if (reset && issued < applied || !reset && issued < (issuedResetSeqByBucket.get(guardKey) ?? 0)) return null;
    if (reset) appliedResetSeqByBucket.set(guardKey, issued);
    const result = applyResponse(scope, data, reset, resurrectDestroyed);
    const previous = getDbQueryClient().getQueryData(queryKeyOf(key));
    const previousPages = previous?.pages ?? 0;
    const pages = config.page ? reset ? 1 : previousPages + 1 : 1;
    /** maxPages is a hard ceiling: once reached, the chain reports exhaustion and fetchNextPage stops issuing requests. */
    const hasNextPage = result.meta.hasNextPage && (config.maxPages === undefined || pages < config.maxPages);
    return {
      lastCount: result.meta.count,
      cursor: config.page && hasNextPage ? result.meta.endCursor : null,
      pages,
      hasNextPage,
      ids: reset ? result.ids : union(previous?.ids ?? [], result.ids),
      resultKind: result.resultKind
    };
  };
  const staleTimeOf = key => {
    const meta = getDbQueryClient().getQueryData(queryKeyOf(key));
    const defaults = getDbRuntimeConfig().defaults;
    return meta?.lastCount === 0 && (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null ? resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime : resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0;
  };
  const run = async (scope, options) => {
    resolveStaleTime(config.staleTime, getDbRuntimeConfig().defaults);
    resolveStaleTime(config.emptyStaleTime, getDbRuntimeConfig().defaults);
    if (config.enabled && !config.enabled(scope)) return;
    const key = bucketKeyOf(scope);
    const client = getDbQueryClient();
    const queryKey = queryKeyOf(key);
    if (!isFetchNetworkOnline()) {
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
    const generationFence = createGenerationFence();
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
              resultKind: config.page ? 'many' : 'one'
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
      if (error instanceof CancelledError) return;
      if (!isFetchNetworkOnline()) {
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
    const scope = scopeGate(rawScope);
    if (!registerScope(scope)) return;
    await run(scope, {
      restart: true,
      propagateFailure: true
    });
  };
  const invalidate = scope => {
    const client = getDbQueryClient();
    const invalidateScope = registered => {
      const queryKey = queryKeyOf(bucketKeyOf(registered));
      // Invalidation is lazy: freshness drops for everyone, but only mounted readers refetch now.
      void client.invalidateQueries({
        queryKey,
        refetchType: 'none'
      }).then(() => {
        refetchActiveFetchReaders(queryKey);
      });
    };
    if (scope === undefined) {
      for (const registered of registeredScopes.values()) invalidateScope(registered);
      return;
    }
    registerScope(scope);
    for (const registered of registeredScopes.values()) if (matchesPartialScope(registered, scope)) invalidateScope(registered);
  };
  if (destinationModelId) registerModelInvalidation(destinationModelId, keyName, scope => invalidate(scope));
  const useObservedState = key => {
    const client = getDbQueryClient();
    const generation = getRuntimeGeneration();
    const observerRef = useRef(null);
    if (observerRef.current === null || observerRef.current.key !== key || observerRef.current.generation !== generation) {
      observerRef.current = {
        key,
        generation,
        observer: new QueryObserver(client, {
          queryKey: queryKeyOf(key),
          enabled: false,
          staleTime: Infinity
        })
      };
    }
    const observer = observerRef.current.observer;
    const subscribe = useCallback(onStoreChange => {
      const unsubscribeObserver = observer.subscribe(onStoreChange);
      const unsubscribeLocal = localState.subscribe(key, onStoreChange);
      return () => {
        unsubscribeObserver();
        unsubscribeLocal();
      };
    }, [key, observer]);
    const getSnapshot = useCallback(() => `${observer.getCurrentResult().fetchStatus}:${observer.getCurrentResult().status}:${observer.getCurrentResult().failureCount}:${observer.getCurrentResult().dataUpdatedAt}:${localState.version(key)}`, [key, observer]);
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const result = observer.getCurrentResult();
    const local = localState.get(key);
    const meta = result.data ?? undefined;
    return {
      isFetching: result.fetchStatus === 'fetching',
      isFetchingNextPage: local.isFetchingNextPage && result.fetchStatus === 'fetching',
      isFetched: isFetchedResult(result),
      isPaused: local.isPaused,
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null,
      hasNextPage: meta?.hasNextPage ?? false,
      ids: meta?.ids ?? [],
      resultKind: meta?.resultKind ?? (config.page ? 'many' : 'one')
    };
  };
  const useReader = (scope, enabled, resurrectDestroyed, forceAbsentRefetch) => {
    const key = scope === null ? compositeKey(keyName, 'inactive') : bucketKeyOf(scope);
    const state = useObservedState(key);
    const mountedKey = useRef(null);
    const forcedRefetch = useRef(false);
    if (mountedKey.current !== key) forcedRefetch.current = false;
    useEffect(() => {
      if (scope === null || !enabled) return;
      const client = getDbQueryClient();
      const queryKey = queryKeyOf(key);
      const resumeWindow = () => config.resumeStaleTime === undefined ? getDbRuntimeConfig().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = () => {
        const window = resumeWindow();
        if (window === null || isQueryFresh(client, queryKey, window)) return false;
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
        }).catch(() => {})
      });
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const isFresh = isQueryFresh(client, queryKey, staleTimeOf(key));
      const canRefetch = !firstMount || !state.isFetched || (config.refetchOnMount ?? getDbRuntimeConfig().defaults.refetchOnMount) !== false;
      const shouldFetch = firstMount && canRefetch;
      if (shouldFetch && !isFresh && !state.isFetching) {
        void run(scope, {
          restart: false,
          resurrectDestroyed
        }).catch(() => {});
      }
      if (forceAbsentRefetch && state.isFetched && !state.isFetching && !forcedRefetch.current) {
        forcedRefetch.current = true;
        void run(scope, {
          restart: true,
          resurrectDestroyed
        }).catch(() => {});
      }
      const unsubscribeOnline = subscribeFetchNetwork(() => {
        if (!isFetchNetworkOnline()) return;
        if (!isQueryFresh(client, queryKey, staleTimeOf(key))) void run(scope, {
          restart: false,
          resurrectDestroyed
        }).catch(() => {});
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
      loadingState: computeLoadingState(computePhase(phaseInput), phaseInput),
      error: state.error,
      hasNextPage: config.page ? state.hasNextPage : false,
      isFetchingNextPage: config.page ? state.isFetchingNextPage : false,
      fetchNextPage: () => {
        if (scope !== null && config.page && state.hasNextPage && !state.isFetching) void run(scope, {
          restart: false,
          nextPage: true
        }).catch(() => {});
      },
      refetch: async () => {
        if (scope !== null) await run(scope, {
          restart: true
        });
      }
    };
  };
  const useDestinationRows = isScopeDestination(config.into) ? scope => config.into.use(scope) : (_scope, state) => {
    const destination = config.into;
    const rowIds = state.ids.flatMap(id => {
      const parts = parseCompositeKey(id);
      return parts?.length === 2 && parts[0] === destination.modelId ? [parts[1]] : [];
    });
    const rows = destination.use.byIds(rowIds).rows;
    return state.resultKind === 'many' ? rows : rows[0];
  };
  const use = (rawScope, options) => {
    const scope = scopeGate(rawScope);
    registerScope(scope);
    const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const state = useReader(scope, enabled, false, false);
    return buildResult(useDestinationRows(scope, state), enabled, state, scope);
  };
  const handle = {
    use,
    fetch,
    invalidate
  };
  if (isScopeDestination(config.into)) {
    const scopeHandle = config.into;
    const useWindow = (rawScope, options) => {
      const scope = scopeGate(rawScope);
      registerScope(scope);
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
  const useRowEnsured = (scope, rowId, readOpts) => {
    registerScope(scope);
    const storedData = destination.get?.(rowId);
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
//# sourceMappingURL=defineQuery.js.map