import { CancelledError, QueryObserver } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FetchConfig, FetchData, FetchHandle, FetchResult, FetchState } from '../types';
import { computeLoadingState, computePhase } from '../queries/base/loadingState';
import { buildScopeKey } from '../core/compileDbWhere';
import { getDbTransport, responseDataOrThrow } from '../core/transport';
import { getDbLogger } from '../core/logger';
import { registerActiveFetchReaders } from '../core/fetch/fetchReaderRegistry';
import { isFetchNetworkOnline, subscribeFetchNetwork } from '../core/fetch/networkState';
import { getDbQueryClient, getDbRuntimeConfig, getRuntimeGeneration } from './configure';
import { createGenerationFence } from '../utils/runtimeGeneration';


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
  const pausedKeys = new Set<string>();
  const pausedListeners = new Map<string, Set<() => void>>();
  const pausedVersions = new Map<string, number>();
  const setPaused = (key: string, paused: boolean): void => {
    if (pausedKeys.has(key) === paused) return;
    if (paused) pausedKeys.add(key);
    else pausedKeys.delete(key);
    pausedVersions.set(key, (pausedVersions.get(key) ?? 0) + 1);
    for (const listener of pausedListeners.get(key) ?? []) listener();
  };
  const subscribePaused = (key: string, listener: () => void): (() => void) => {
    const keyListeners = pausedListeners.get(key) ?? new Set<() => void>();
    pausedListeners.set(key, keyListeners);
    keyListeners.add(listener);
    return () => {
      keyListeners.delete(listener);
      if (keyListeners.size === 0) pausedListeners.delete(key);
    };
  };

  const staleTimeOf = (key: string): number => {
    const data = getDbQueryClient().getQueryData(queryKeyOf(key)) as FetchData<TSelected> | undefined;
    const defaults = getDbRuntimeConfig().defaults;
    return data?.empty === true && (config.emptyStaleTime ?? defaults.emptyStaleTime) != null ? (config.emptyStaleTime ?? defaults.emptyStaleTime)! : (config.staleTime ?? defaults.staleTime ?? 0);
  };
  const execute = async (input: TInput): Promise<FetchData<TSelected>> => {
    let data: TData;
    try {
      data = config.fetcher ? await config.fetcher(input) : responseDataOrThrow(await getDbTransport().query({ query: config.document, variables: config.vars?.(input) ?? {} }));
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults.onSyncError?.(reported, { source: 'query', key: config.key });
      } catch (observerError) {
        getDbLogger().error('defineFetch onSyncError failed', { error: observerError });
      }
      throw error;
    }
    const selected = config.select(data);
    return { selected, empty: isEmpty(selected) };
  };
  const isFreshKey = (key: string): boolean => {
    const client = getDbQueryClient();
    const state = client.getQueryState(queryKeyOf(key));
    return state?.dataUpdatedAt !== undefined && state.dataUpdatedAt > 0 && Date.now() - state.dataUpdatedAt <= staleTimeOf(key) && !state.isInvalidated;
  };
  const run = async (input: TInput, options: { restart: boolean; propagateFailure?: boolean }): Promise<TSelected> => {
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
    const generation = getRuntimeGeneration();
    try {
      const data = await client.fetchQuery<FetchData<TSelected>>({
        queryKey,
        queryFn: async () => {
          const result = await execute(input);
          if (getRuntimeGeneration() !== generation) return (client.getQueryData(queryKey) as FetchData<TSelected> | undefined) ?? result;
          return result;
        },
        staleTime: options.restart ? 0 : staleTimeOf(key)
      });
      return data.selected;
    } catch (error) {
      // A newer restart cancelled this fetch; the superseding run now owns key state and outcome.
      if (error instanceof CancelledError) return (client.getQueryData(queryKey) as FetchData<TSelected> | undefined)?.selected as TSelected;
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
    pausedKeys.clear();
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
        const unsubscribePaused = subscribePaused(key, onStoreChange);
        return () => {
          unsubscribeObserver();
          unsubscribePaused();
        };
      },
      [key, observer]
    );
    const getSnapshot = useCallback(() => {
      const result = observer.getCurrentResult();
      return `${result.fetchStatus}:${result.status}:${result.failureCount}:${result.dataUpdatedAt}:${pausedVersions.get(key) ?? 0}`;
    }, [key, observer]);
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const result = observer.getCurrentResult();
    const state: FetchState = {
      isFetching: result.fetchStatus === 'fetching',
      isFetched: result.dataUpdatedAt > 0 || result.errorUpdatedAt > 0,
      isPaused: pausedKeys.has(key),
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
        const queryState = client.getQueryState(queryKey);
        const fresh = queryState?.dataUpdatedAt !== undefined && queryState.dataUpdatedAt > 0 && Date.now() - queryState.dataUpdatedAt <= window! && !queryState.isInvalidated;
        if (window === null || fresh) return false;
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
      if (firstMount && canRefetch && !isFreshKey(key) && !state.isFetching) void run(input, { restart: false }).catch(() => {});
      const unsubscribeOnline = subscribeFetchNetwork(() => {
        if (isFetchNetworkOnline() && !isFreshKey(key)) void run(input, { restart: false }).catch(() => {});
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
