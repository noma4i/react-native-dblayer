"use strict";

import { useEffect, useMemo, useRef } from 'react';
import { computeLoadingState, computePhase, isFetchedResult } from "../queries/base/loadingState.js";
import { useObservedQuery } from "../core/fetch/useObservedQuery.js";
import { buildScopeKey } from "../core/compileDbWhere.js";
import { registerKeyedReset } from "../core/reset.js";
import { createKeyedLocalState } from "../core/fetch/keyedLocalState.js";
import { getDbTransport, responseDataOrThrow } from "../core/transport.js";
import { registerActiveFetchReaders } from "../core/fetch/fetchReaderRegistry.js";
import { createOfflineFetchError, isFetchNetworkOnline } from "../core/fetch/networkState.js";
import { isQueryFresh, persistenceWindowOf, resolveStaleTime } from "../core/fetch/queryFreshness.js";
import { getDbQueryClient, getDbRuntimeConfig } from "./configure.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { reportSyncError } from "../core/syncError.js";
import { removePersistedQuery } from "../core/queryPersistence.js";
import { persistBucket, restorePersistedBucket } from "../core/fetch/persistedBucket.js";
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
  /** Flags react-query's state machine does not carry in our vocabulary: offline pause and the per-key invalidate sequence. */
  const localState = createKeyedLocalState({
    isPaused: false,
    invalidateSeq: 0
  });
  registerKeyedReset(`fetch:${handleKey}`, () => localState.clear());
  const setPaused = (key, paused) => localState.set(key, {
    isPaused: paused
  });
  const bumpInvalidateSeq = key => localState.set(key, {
    invalidateSeq: localState.get(key).invalidateSeq + 1
  });
  const staleTimeOf = key => {
    const data = getDbQueryClient().getQueryData(queryKeyOf(key));
    const defaults = getDbRuntimeConfig().defaults;
    return data?.empty === true && (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null ? resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime : resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0;
  };
  const persistenceWindow = empty => persists ? persistenceWindowOf(empty, config.staleTime, config.emptyStaleTime, getDbRuntimeConfig().defaults) : null;
  const restore = input => {
    const key = keyOf(input);
    const cached = getDbQueryClient().getQueryData(queryKeyOf(key));
    if (cached !== undefined || !persists) return cached;
    return restorePersistedBucket({
      declaration: persistenceDeclaration,
      identity: key,
      queryKey: queryKeyOf(key),
      validate: candidate => {
        const voidInputMatches = input === undefined && candidate.scope === null;
        if (!voidInputMatches && keyOf(candidate.scope) !== key) {
          throw new Error('react-native-dblayer: persisted fetch input does not match its identity');
        }
        const selected = config.validate ? config.validate(candidate.payload) : candidate.payload;
        return {
          payload: selected,
          scope: input
        };
      },
      cache: selected => ({
        selected,
        empty: isEmpty(selected)
      }),
      window: persistenceWindow
    });
  };
  const persist = (input, data) => {
    if (!persists) return;
    const key = keyOf(input);
    persistBucket({
      declaration: persistenceDeclaration,
      identity: key,
      queryKey: queryKeyOf(key),
      scope: input === undefined ? null : input,
      payload: data.selected,
      empty: data.empty,
      window: persistenceWindow
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
      const cached = client.getQueryData(queryKey);
      if (cached === undefined && options.propagateFailure) throw createOfflineFetchError();
      return cached?.selected;
    }
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({
      queryKey
    });
    setPaused(key, false);
    const generationFence = createGenerationFence();
    const invalidateSeqAtStart = localState.get(key).invalidateSeq;
    try {
      const data = await client.fetchQuery({
        queryKey,
        queryFn: async () => {
          return await execute(input, generationFence.isCurrent);
        },
        staleTime: options.restart ? 0 : staleTimeOf(key)
      });
      persist(input, data);
      if (localState.get(key).invalidateSeq !== invalidateSeqAtStart) {
        // An invalidate landed while this fetch was in flight. The response predates it, so it
        // cannot satisfy it: restore the invalidated mark the landing cleared and run once more.
        await client.invalidateQueries({
          queryKey,
          exact: true,
          refetchType: 'none'
        });
        return await run(input, {
          restart: false,
          propagateFailure: options.propagateFailure
        });
      }
      return data.selected;
    } catch (error) {
      if (!generationFence.isCurrent()) {
        if (options.propagateFailure) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
        return client.getQueryData(queryKey)?.selected;
      }
      if (!isFetchNetworkOnline()) {
        setPaused(key, true);
        const cached = client.getQueryData(queryKey);
        if (cached === undefined && options.propagateFailure) throw createOfflineFetchError();
        return cached?.selected;
      }
      const cached = client.getQueryData(queryKey);
      if (!options.restart && cached !== undefined) return cached.selected;
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
    // One entry point for every automatic fetch of this key, same as the model-query surface: the
    // declared window is the observer's real `staleTime`, so first load, mounting on stale data and
    // reconnect are React Query's decisions. `run` stays for `fetch` and `refresh`, where the caller
    // owns the outcome and the error.
    const observerOptions = {
      queryKey: queryKeyOf(key),
      enabled,
      staleTime: staleTimeOf(key),
      // Paused offline and resumed on reconnect; the imperative path keeps the runtime default so an
      // awaited `fetch()` fails instead of waiting for the network.
      networkMode: 'online',
      refetchOnMount: getDbRuntimeConfig().defaults.refetchOnMount ?? true,
      refetchOnReconnect: true,
      queryFn: async () => {
        const fence = createGenerationFence();
        let issuedAt = localState.get(key).invalidateSeq;
        let data = await execute(input, fence.isCurrent);
        // An invalidate issued after this request left outranks its answer; see defineQuery.
        while (fence.isCurrent() && localState.get(key).invalidateSeq !== issuedAt) {
          issuedAt = localState.get(key).invalidateSeq;
          data = await execute(input, fence.isCurrent);
        }
        return data;
      }
    };
    const result = useObservedQuery(key, observerOptions, `${enabled}:${staleTimeOf(key)}`, localState);
    const state = {
      isFetching: result.fetchStatus === 'fetching',
      isFetched: isFetchedResult(result),
      isPaused: localState.get(key).isPaused || result.fetchStatus === 'paused',
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
        bumpInvalidateSeq(key);
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
      mountedKey.current = key;
      return release;
    }, [client, enabled, input, key, state.isFetched, state.isFetching]);
    // Whatever path landed the value, its freshness has to survive a restart; following the landing
    // timestamp records both the imperative and the scheduled landing.
    useEffect(() => {
      if (!persists || result.dataUpdatedAt === 0) return;
      const landed = client.getQueryData(queryKeyOf(key));
      if (landed !== undefined) persist(input, landed);
    }, [client, input, key, result.dataUpdatedAt]);
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