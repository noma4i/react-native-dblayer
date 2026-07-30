import { QueryObserver } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FetchConfig, FetchData, FetchHandle, FetchResult, FetchState } from '../types';
import { computeLoadingState, computePhase, isFetchedResult } from '../queries/base/loadingState';
import { buildScopeKey } from '../core/compileDbWhere';
import { registerKeyedReset } from '../core/reset';
import { createKeyedLocalState } from '../core/fetch/keyedLocalState';
import { getDbTransport, responseDataOrThrow } from '../core/transport';
import { registerActiveFetchReaders } from '../core/fetch/fetchReaderRegistry';
import { isFetchNetworkOnline, subscribeFetchNetwork } from '../core/fetch/networkState';
import { isQueryFresh, resolveStaleTime } from '../core/fetch/queryFreshness';
import { getDbQueryClient, getDbRuntimeConfig, getRuntimeGeneration } from './configure';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { reportSyncError } from '../core/syncError';

let fetchHandleSequence = 0;

/**
 * Define an ephemeral coordinator-owned fetch with no model-store writes.
 *
 * @param config Document or fetcher plus selection and freshness policy.
 * @returns Coordinator-backed reactive and imperative fetch methods.
 */
export const defineFetch = <TData, TInput = void, TSelected = TData>(config: FetchConfig<TData, TInput, TSelected>): FetchHandle<TInput, TSelected> => {
  const hasDocument = config.document !== undefined;
  const hasFetcher = config.fetcher !== undefined;
  if (hasDocument === hasFetcher) throw new Error('defineFetch requires exactly one of document or fetcher');
  const handleKey = `fetch:${config.key ?? (fetchHandleSequence += 1)}`;
  const isEmpty = config.isEmpty ?? ((data: TSelected) => data == null || (Array.isArray(data) && data.length === 0));
  const keyOf = (input: TInput): string => buildScopeKey(input);
  const queryKeyOf = (key: string): [string, string] => [handleKey, key];
  /** Offline pause is the one flag react-query's state machine does not carry in our vocabulary. */
  const localState = createKeyedLocalState({ isPaused: false });
  registerKeyedReset(`fetch:${handleKey}`, () => localState.clear());
  const setPaused = (key: string, paused: boolean): void => localState.set(key, { isPaused: paused });

  const staleTimeOf = (key: string): number => {
    const data = getDbQueryClient().getQueryData(queryKeyOf(key)) as FetchData<TSelected> | undefined;
    const defaults = getDbRuntimeConfig().defaults;
    return data?.empty === true && (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null
      ? (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime)!
      : (resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0);
  };
  const execute = async (input: TInput, isCurrent: () => boolean): Promise<FetchData<TSelected>> => {
    let data: TData;
    try {
      data = config.fetcher ? await config.fetcher(input) : responseDataOrThrow(await getDbTransport().query({ query: config.document, variables: config.vars?.(input) ?? {} }));
    } catch (error) {
      if (!isCurrent()) throw error;
      reportSyncError(error, { source: 'query', key: config.key }, 'defineFetch');
      throw error;
    }
    if (!isCurrent()) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    const selected = config.select(data);
    return { selected, empty: isEmpty(selected) };
  };
  const isFreshKey = (key: string): boolean => {
    const client = getDbQueryClient();
    return isQueryFresh(client, queryKeyOf(key), staleTimeOf(key));
  };
  const run = async (input: TInput, options: { restart: boolean; propagateFailure?: boolean }): Promise<TSelected> => {
    resolveStaleTime(config.staleTime, getDbRuntimeConfig().defaults);
    resolveStaleTime(config.emptyStaleTime, getDbRuntimeConfig().defaults);
    const key = keyOf(input);
    const client = getDbQueryClient();
    const queryKey = queryKeyOf(key);
    if (!isFetchNetworkOnline()) {
      setPaused(key, true);
      return (client.getQueryData(queryKey) as FetchData<TSelected> | undefined)?.selected as TSelected;
    }
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({ queryKey });
    setPaused(key, false);
    const generationFence = createGenerationFence();
    try {
      const data = await client.fetchQuery<FetchData<TSelected>>({
        queryKey,
        queryFn: async () => {
          return await execute(input, generationFence.isCurrent);
        },
        staleTime: options.restart ? 0 : staleTimeOf(key)
      });
      return data.selected;
    } catch (error) {
      if (!generationFence.isCurrent()) {
        if (options.propagateFailure) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
        return (client.getQueryData(queryKey) as FetchData<TSelected> | undefined)?.selected as TSelected;
      }
      if (!isFetchNetworkOnline()) {
        setPaused(key, true);
        return (client.getQueryData(queryKey) as FetchData<TSelected> | undefined)?.selected as TSelected;
      }
      if (options.propagateFailure) throw error instanceof Error ? error : new Error(String(error));
      return (client.getQueryData(queryKey) as FetchData<TSelected> | undefined)?.selected as TSelected;
    }
  };
  const fetch = async (input: TInput): Promise<TSelected> => {
    const generationFence = createGenerationFence();
    const key = keyOf(input);
    const cached = getDbQueryClient().getQueryData(queryKeyOf(key)) as FetchData<TSelected> | undefined;
    if (cached !== undefined && isFreshKey(key)) return cached.selected;
    const selected = await run(input, { restart: false, propagateFailure: true });
    if (!generationFence.isCurrent()) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    return selected;
  };
  const remove = (): void => {
    getDbQueryClient().removeQueries({ queryKey: [handleKey] });
    localState.clear();
  };
  const use = (input: TInput): FetchResult<TSelected> => {
    const key = keyOf(input);
    const enabled = config.enabled?.(input) ?? true;
    const client = getDbQueryClient();
    const generation = getRuntimeGeneration();
    const observerRef = useRef<{ key: string; generation: number; observer: QueryObserver<FetchData<TSelected>> } | null>(null);
    if (observerRef.current === null || observerRef.current.key !== key || observerRef.current.generation !== generation) {
      observerRef.current = { key, generation, observer: new QueryObserver<FetchData<TSelected>>(client, { queryKey: queryKeyOf(key), enabled: false, staleTime: Infinity }) };
    }
    const observer = observerRef.current.observer;
    const subscribe = useCallback(
      (onStoreChange: () => void) => {
        const unsubscribeObserver = observer.subscribe(onStoreChange);
        const unsubscribePaused = localState.subscribe(key, onStoreChange);
        return () => {
          unsubscribeObserver();
          unsubscribePaused();
        };
      },
      [key, observer]
    );
    const getSnapshot = useCallback(() => {
      const result = observer.getCurrentResult();
      return `${result.fetchStatus}:${result.status}:${result.failureCount}:${result.dataUpdatedAt}:${localState.version(key)}`;
    }, [key, observer]);
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const result = observer.getCurrentResult();
    const state: FetchState = {
      isFetching: result.fetchStatus === 'fetching',
      isFetched: isFetchedResult(result),
      isPaused: localState.get(key).isPaused,
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null
    };
    const mountedKey = useRef<string | null>(null);
    useEffect(() => {
      if (!enabled) return;
      const queryKey = queryKeyOf(key);
      const resumeWindow = (): number | null => config.resumeStaleTime === undefined ? getDbRuntimeConfig().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = (): boolean => {
        const window = resumeWindow();
        if (window === null || isQueryFresh(client, queryKey, window)) return false;
        void client.invalidateQueries({ queryKey, refetchType: 'none' });
        return true;
      };
      const release = registerActiveFetchReaders({
        queryKey,
        markResumeStale,
        refetch: async () => {
          await run(input, { restart: false });
        }
      });
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const canRefetch = !firstMount || !state.isFetched || getDbRuntimeConfig().defaults.refetchOnMount !== false;
      if (firstMount && canRefetch && !isFreshKey(key) && !state.isFetching) void run(input, { restart: false });
      const unsubscribeOnline = subscribeFetchNetwork(() => {
        if (isFetchNetworkOnline() && !isFreshKey(key)) void run(input, { restart: false });
      });
      return () => {
        unsubscribeOnline();
        release();
      };
    }, [client, enabled, input, key, state.isFetched, state.isFetching]);
    const data = (result.data as FetchData<TSelected> | undefined)?.selected;
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
    return useMemo(() => ({ data, loadingState, error: state.error, refetch: () => void run(input, { restart: true }) }), [data, loadingState, state.error, input]);
  };
  return { use, fetch, remove };
};
