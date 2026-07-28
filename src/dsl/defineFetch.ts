import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FetchConfig, FetchHandle, FetchResult } from '../types';
import { computeLoadingState, computePhase } from '../queries/base/loadingState';
import { buildScopeKey } from '../core/compileDbWhere';
import { getDbTransport, responseDataOrThrow } from '../core/transport';
import { getDbLogger } from '../core/logger';
import { createFetchLedger } from '../core/fetch/fetchLedger';
import { isFetchNetworkOnline, registerFetchLedger, subscribeFetchNetwork } from '../core/fetch/fetchLedgerRegistry';
import { getDbRuntimeConfig } from './configure';
import { registerReset } from '../core/reset';
import { createGenerationFence } from '../utils/runtimeGeneration';

type FetchState = { isFetching: boolean; isFetched: boolean; isPaused: boolean; retryAttempt: number; error: Error | null };

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
  const values = new Map<string, TSelected>();
  const inputs = new Map<string, TInput>();
  const states = new Map<string, FetchState>();
  const listeners = new Map<string, Set<() => void>>();
  const versions = new Map<string, number>();
  const isEmpty = config.isEmpty ?? ((data: TSelected) => data == null || (Array.isArray(data) && data.length === 0));
  const keyOf = (input: TInput): string => buildScopeKey(input);
  const stateOf = (key: string): FetchState => states.get(key) ?? { isFetching: false, isFetched: false, isPaused: false, retryAttempt: 0, error: null };
  const emit = (key: string): void => {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const setState = (key: string, next: Partial<FetchState>): void => {
    states.set(key, { ...stateOf(key), ...next });
    emit(key);
  };
  const subscribe = (key: string, listener: () => void): (() => void) => {
    const keyListeners = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, keyListeners);
    keyListeners.add(listener);
    return () => {
      keyListeners.delete(listener);
      if (keyListeners.size === 0) listeners.delete(key);
    };
  };
  const ledger = createFetchLedger({
    now: Date.now,
    retry: getDbRuntimeConfig().defaults.retry?.query ?? {},
    isOnline: isFetchNetworkOnline,
    onStamp: emit,
    maxEntries: Number.MAX_SAFE_INTEGER
  });
  registerFetchLedger(ledger);
  registerReset(() => {
    values.clear();
    inputs.clear();
    states.clear();
    versions.clear();
  });

  const staleTimeOf = (key: string): number => {
    const entry = ledger.read(key);
    const defaults = getDbRuntimeConfig().defaults;
    return entry?.lastCount === 0 && (config.emptyStaleTime ?? defaults.emptyStaleTime) != null ? (config.emptyStaleTime ?? defaults.emptyStaleTime)! : (config.staleTime ?? defaults.staleTime ?? 0);
  };
  const execute = async (input: TInput, key: string, context: { attempt: number; isCurrent: () => boolean }) => {
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
    if (!context.isCurrent()) return { applied: false as const };
    const selected = config.select(data);
    values.set(key, selected);
    return { applied: true as const, count: isEmpty(selected) ? 0 : 1, ids: [] };
  };
  const run = async (input: TInput, options: { restart: boolean; propagateFailure?: boolean }): Promise<TSelected> => {
    const key = keyOf(input);
    inputs.set(key, input);
    if (options.restart) ledger.invalidate(key);
    setState(key, { isFetching: true, isPaused: false, error: null, retryAttempt: 0 });
    let lastError: Error | null = null;
    const status = await ledger.run(key, async context => {
      setState(key, { retryAttempt: context.attempt - 1 });
      try {
        return await execute(input, key, context);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    });
    setState(key, { isFetching: false, isPaused: status === 'offline', isFetched: stateOf(key).isFetched || status === 'applied' || status === 'failed', retryAttempt: 0, error: status === 'failed' ? lastError : null });
    if (status === 'failed' && options.propagateFailure) throw lastError ?? new Error('react-native-dblayer: fetch failed without an error');
    return values.get(key) as TSelected;
  };
  const fetch = async (input: TInput): Promise<TSelected> => {
    const generationFence = createGenerationFence();
    const key = keyOf(input);
    if (values.has(key) && ledger.isFresh(key, staleTimeOf(key))) return values.get(key) as TSelected;
    const selected = await run(input, { restart: false, propagateFailure: true });
    if (!generationFence.isCurrent()) throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    return selected;
  };
  const remove = (): void => {
    for (const key of inputs.keys()) {
      ledger.invalidate(key);
      values.delete(key);
      states.delete(key);
      emit(key);
    }
    inputs.clear();
  };
  const use = (input: TInput): FetchResult<TSelected> => {
    const key = keyOf(input);
    inputs.set(key, input);
    const enabled = config.enabled?.(input) ?? true;
    const version = useSyncExternalStore(listener => subscribe(key, listener), () => versions.get(key) ?? 0, () => 0);
    const mountedKey = useRef<string | null>(null);
    const state = stateOf(key);
    useEffect(() => {
      if (!enabled) return;
      const resumeWindow = (): number | null => config.resumeStaleTime === undefined ? getDbRuntimeConfig().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = (): boolean => {
        const window = resumeWindow();
        if (window === null || ledger.isFresh(key, window)) return false;
        ledger.invalidate(key);
        return true;
      };
      const release = ledger.retain(key, async () => {
        await run(input, { restart: false });
      }, markResumeStale);
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const canRefetch = !firstMount || !state.isFetched || getDbRuntimeConfig().defaults.refetchOnMount !== false;
      if (firstMount && canRefetch && !ledger.isFresh(key, staleTimeOf(key)) && !state.isFetching) void run(input, { restart: false }).catch(() => {});
      const unsubscribeOnline = subscribeFetchNetwork(() => {
        if (isFetchNetworkOnline() && !ledger.isFresh(key, staleTimeOf(key))) void run(input, { restart: false }).catch(() => {});
      });
      return () => {
        unsubscribeOnline();
        release();
      };
    }, [enabled, input, key, state.isFetched, state.isFetching, version]);
    const data = values.get(key);
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
