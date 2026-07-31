"use strict";

import { QueryObserver } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { computeLoadingState, computePhase, isFetchedResult } from "../queries/base/loadingState.js";
import { buildScopeKey } from "../core/compileDbWhere.js";
import { registerKeyedReset } from "../core/reset.js";
import { createKeyedLocalState } from "../core/fetch/keyedLocalState.js";
import { getDbTransport, responseDataOrThrow } from "../core/transport.js";
import { registerActiveFetchReaders } from "../core/fetch/fetchReaderRegistry.js";
import { isFetchNetworkOnline, subscribeFetchNetwork } from "../core/fetch/networkState.js";
import { isQueryFresh, resolveStaleTime } from "../core/fetch/queryFreshness.js";
import { getDbQueryClient, getDbRuntimeConfig, getRuntimeGeneration } from "./configure.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { reportSyncError } from "../core/syncError.js";
import { readPersistedQuery, removePersistedQuery, writePersistedQuery } from "../core/queryPersistence.js";
import { stableSerialize } from "../core/serialize.js";
let fetchHandleSequence = 0;

/**
 * Define an ephemeral coordinator-owned fetch with no model-store writes.
 *
 * @param config Document or fetcher plus selection and freshness policy.
 * @returns Coordinator-backed reactive and imperative fetch methods.
 */
export const defineFetch = config => {
  const hasDocument = config.document !== undefined;
  const hasFetcher = config.fetcher !== undefined;
  if (hasDocument === hasFetcher) throw new Error('defineFetch requires exactly one of document or fetcher');
  const handleKey = `fetch:${config.key ?? (fetchHandleSequence += 1)}`;
  const persistenceVersion = config.persistenceVersion ?? 1;
  const persistenceDeclaration = {
    family: handleKey,
    persistenceVersion,
    fingerprint: stableSerialize({
      kind: 'fetch',
      key: config.key ?? null,
      persistenceVersion
    })
  };
  const persists = config.key !== undefined;
  const isEmpty = config.isEmpty ?? (data => data == null || Array.isArray(data) && data.length === 0);
  const keyOf = input => buildScopeKey(input);
  const queryKeyOf = key => [handleKey, key];
  /** Offline pause is the one flag react-query's state machine does not carry in our vocabulary. */
  const localState = createKeyedLocalState({
    isPaused: false
  });
  registerKeyedReset(`fetch:${handleKey}`, () => localState.clear());
  const setPaused = (key, paused) => localState.set(key, {
    isPaused: paused
  });
  const staleTimeOf = key => {
    const data = getDbQueryClient().getQueryData(queryKeyOf(key));
    const defaults = getDbRuntimeConfig().defaults;
    return data?.empty === true && (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null ? resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime : resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0;
  };
  const persistenceWindow = empty => {
    if (!persists) return null;
    const defaults = getDbRuntimeConfig().defaults;
    const window = empty ? resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime ?? resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0 : resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0;
    return Number.isFinite(window) && window > 0 ? window : null;
  };
  const restore = input => {
    const key = keyOf(input);
    const client = getDbQueryClient();
    const queryKey = queryKeyOf(key);
    const cached = client.getQueryData(queryKey);
    if (cached !== undefined || !persists) return cached;
    const record = readPersistedQuery(persistenceDeclaration, key, candidate => {
      const voidInputMatches = input === undefined && candidate.scope === null;
      if (!voidInputMatches && keyOf(candidate.scope) !== key) {
        throw new Error('react-native-dblayer: persisted fetch input does not match its identity');
      }
      const selected = config.validate ? config.validate(candidate.payload) : candidate.payload;
      return {
        payload: selected,
        scope: input
      };
    });
    if (record === undefined) return undefined;
    const restored = {
      selected: record.payload,
      empty: isEmpty(record.payload)
    };
    if (persistenceWindow(restored.empty) === null) {
      removePersistedQuery(persistenceDeclaration, key);
      return undefined;
    }
    client.setQueryData(queryKey, restored, {
      updatedAt: record.dataUpdatedAt
    });
    if (record.invalidated) void client.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: 'none'
    });
    return restored;
  };
  const persist = (input, data) => {
    const key = keyOf(input);
    if (persistenceWindow(data.empty) === null) {
      if (persists) removePersistedQuery(persistenceDeclaration, key);
      return;
    }
    const dataUpdatedAt = getDbQueryClient().getQueryState(queryKeyOf(key)).dataUpdatedAt;
    writePersistedQuery({
      ...persistenceDeclaration,
      identity: key,
      scope: input === undefined ? null : input,
      payload: data.selected,
      empty: data.empty,
      dataUpdatedAt
    });
  };
  const execute = async (input, isCurrent) => {
    let data;
    try {
      data = config.fetcher ? await config.fetcher(input) : responseDataOrThrow(await getDbTransport().query({
        query: config.document,
        variables: config.vars?.(input) ?? {}
      }));
    } catch (error) {
      if (!isCurrent()) throw error;
      reportSyncError(error, {
        source: 'query',
        key: config.key
      }, 'defineFetch');
      throw error;
    }
    if (!isCurrent()) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    let selected;
    try {
      const value = config.select(data);
      selected = config.validate ? config.validate(value) : value;
    } catch (error) {
      reportSyncError(error, {
        source: 'query',
        key: config.key
      }, 'defineFetch');
      throw error;
    }
    return {
      selected,
      empty: isEmpty(selected)
    };
  };
  const isFreshKey = key => {
    const client = getDbQueryClient();
    return isQueryFresh(client, queryKeyOf(key), staleTimeOf(key));
  };
  const run = async (input, options) => {
    resolveStaleTime(config.staleTime, getDbRuntimeConfig().defaults);
    resolveStaleTime(config.emptyStaleTime, getDbRuntimeConfig().defaults);
    const key = keyOf(input);
    const client = getDbQueryClient();
    const queryKey = queryKeyOf(key);
    restore(input);
    if (!isFetchNetworkOnline()) {
      setPaused(key, true);
      return client.getQueryData(queryKey)?.selected;
    }
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({
      queryKey
    });
    setPaused(key, false);
    const generationFence = createGenerationFence();
    try {
      const data = await client.fetchQuery({
        queryKey,
        queryFn: async () => {
          return await execute(input, generationFence.isCurrent);
        },
        staleTime: options.restart ? 0 : staleTimeOf(key)
      });
      persist(input, data);
      return data.selected;
    } catch (error) {
      if (!generationFence.isCurrent()) {
        if (options.propagateFailure) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
        return client.getQueryData(queryKey)?.selected;
      }
      if (!isFetchNetworkOnline()) {
        setPaused(key, true);
        return client.getQueryData(queryKey)?.selected;
      }
      if (options.propagateFailure) throw error instanceof Error ? error : new Error(String(error));
      return client.getQueryData(queryKey)?.selected;
    }
  };
  const fetch = async input => {
    const generationFence = createGenerationFence();
    const key = keyOf(input);
    const cached = restore(input);
    if (cached !== undefined && isFreshKey(key)) return cached.selected;
    const selected = await run(input, {
      restart: false,
      propagateFailure: true
    });
    if (!generationFence.isCurrent()) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    return selected;
  };
  const refresh = async input => await run(input, {
    restart: true,
    propagateFailure: true
  });
  const read = input => restore(input)?.selected;
  const remove = () => {
    getDbQueryClient().removeQueries({
      queryKey: [handleKey]
    });
    removePersistedQuery(persistenceDeclaration);
    localState.clear();
  };
  const use = input => {
    const key = keyOf(input);
    restore(input);
    const enabled = config.enabled?.(input) ?? true;
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
      const unsubscribePaused = localState.subscribe(key, onStoreChange);
      return () => {
        unsubscribeObserver();
        unsubscribePaused();
      };
    }, [key, observer]);
    const getSnapshot = useCallback(() => {
      const result = observer.getCurrentResult();
      return `${result.fetchStatus}:${result.status}:${result.failureCount}:${result.dataUpdatedAt}:${localState.version(key)}`;
    }, [key, observer]);
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const result = observer.getCurrentResult();
    const state = {
      isFetching: result.fetchStatus === 'fetching',
      isFetched: isFetchedResult(result),
      isPaused: localState.get(key).isPaused,
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null
    };
    const mountedKey = useRef(null);
    useEffect(() => {
      if (!enabled) return;
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
        refetch: async () => {
          await run(input, {
            restart: false
          });
        }
      });
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const canRefetch = !firstMount || !state.isFetched || getDbRuntimeConfig().defaults.refetchOnMount !== false;
      if (firstMount && canRefetch && !isFreshKey(key) && !state.isFetching) void run(input, {
        restart: false
      });
      const unsubscribeOnline = subscribeFetchNetwork(() => {
        if (isFetchNetworkOnline() && !isFreshKey(key)) void run(input, {
          restart: false
        });
      });
      return () => {
        unsubscribeOnline();
        release();
      };
    }, [client, enabled, input, key, state.isFetched, state.isFetching]);
    const data = result.data?.selected;
    const hasData = data !== undefined && !isEmpty(data);
    const phaseInput = {
      isInactive: !enabled && !hasData,
      isFetching: state.isFetching,
      committedRowsDied: false,
      isPaused: state.isPaused,
      retryAttempt: state.retryAttempt,
      hasData,
      isRefreshing: state.isFetching && hasData,
      isFetchingNextPage: false,
      isError: state.error !== null,
      hasFetchedData: state.isFetched
    };
    const loadingState = computeLoadingState(computePhase(phaseInput), phaseInput);
    return useMemo(() => ({
      data,
      loadingState,
      error: state.error,
      refresh: () => void run(input, {
        restart: true
      })
    }), [data, loadingState, state.error, input]);
  };
  return {
    use,
    read,
    fetch,
    refresh,
    remove
  };
};
//# sourceMappingURL=defineFetch.js.map