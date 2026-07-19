import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DbGraphQLDocument, LoadingState } from '../types';
import { computeLoadingState, computePhase } from '../queries/base/loadingState';
import { buildScopeKey } from '../core/compileDbWhere';
import { getDbTransport } from '../core/transport';
import { getDbLogger } from '../core/logger';
import { createGenerationFence } from '../utils/runtimePrimitives';
import { getDbRuntimeConfig, getInternalQueryClient } from './configure';
import { registerBootValidation } from './bootValidations';

type FetchConfigBase<TData, TInput, TSelected> = {
  /** Stable cache-key namespace for this fetch, combined with a hash of `input`. */
  key: string;
  /** Pick the payload to expose as `data`; the raw response is never returned. */
  select: (data: TData) => TSelected;
  /** Derive GraphQL variables from the hook/imperative call input. Omit for input-less queries. */
  vars?: (input: TInput) => Record<string, unknown>;
  /** Gate `use(input)`'s automatic network fetch; `false` keeps the hook network-idle. Does not affect `fetch(input)`. */
  enabled?: (input: TInput) => boolean;
  /** Freshness window (ms) before a result is considered stale and refetched. Defaults to `DbDefaults.staleTime`, then `0`. */
  staleTime?: number;
  /** Freshness window (ms) used instead of `staleTime` when `isEmpty` classifies the last selected result as empty. Defaults to `DbDefaults.emptyStaleTime`. */
  emptyStaleTime?: number;
  /** Classify a selected result as empty. Defaults to nullish values and empty arrays. */
  isEmpty?: (data: TSelected) => boolean;
  /** TanStack Query cache garbage-collection time (ms). Defaults to `DbDefaults.gcTime`. */
  gcTime?: number;
};

type FetchConfig<TData, TInput, TSelected> = FetchConfigBase<TData, TInput, TSelected> &
  (
    | {
        /** The GraphQL query document. `TData` flows from a `TypedDocumentNode`. */
        document: DbGraphQLDocument<TData, Record<string, unknown>>;
        fetcher?: never;
      }
    | {
        /** Execute a store-free request without a GraphQL transport operation. */
        fetcher: (input: TInput) => Promise<TData>;
        document?: never;
      }
  );

/** Reactive result of `fetchQuery.use(input)`. */
export type FetchResult<TSelected> = {
  /** The selected payload; `undefined` before the first successful fetch. */
  data: TSelected | undefined;
  /** UI loading-state machine derived from fetch status and whether `data` is present. */
  loadingState: LoadingState;
  /** The last fetch error, or `null`. */
  error: unknown;
  /** Re-run the fetch, replacing `data` on success. Does not return a promise - await `fetch(input)` instead. */
  refetch: () => void;
};

/**
 * Define an ephemeral, store-free fetch: runs GraphQL or a custom fetcher, selects a payload, and exposes it through
 * a reactive TanStack Query-backed hook plus an imperative call. Unlike `defineQuery`, there is no `into`
 * destination - the response never reaches the apply pipeline, never writes a journal record, and never
 * touches a `dbl:` storage key. Use it for display-only data with no local reactive read of its own
 * (pricing tables, country lists, SKU catalogs) where a `defineQuery` write destination would be pure
 * overhead.
 *
 * @param config Document, cache key, `select`, and optional variables, enablement, freshness, empty-result, and cache-lifetime policies.
 * @returns `{ use, fetch, remove }`. `use(input)` is a hook returning a `FetchResult`. `fetch(input)` runs
 * through the owned query client. `remove()` drops every cached input for this key.
 */
export const defineFetch = <TData, TInput = void, TSelected = TData>(config: FetchConfig<TData, TInput, TSelected>) => {
  const queryKeyOf = (input: TInput): unknown[] => ['dbl-fetch', config.key, buildScopeKey(input)];
  const hasDocument = config.document !== undefined;
  const hasFetcher = config.fetcher !== undefined;
  registerBootValidation(() => {
    if (hasDocument === hasFetcher) throw new Error('defineFetch requires exactly one of document or fetcher');
  });
  const isEmpty = config.isEmpty ?? ((data: TSelected) => data == null || (Array.isArray(data) && data.length === 0));
  const resolveStaleTime = (): number | ((query: { state: { data: unknown; dataUpdatedAt: number } }) => number) => {
    const defaults = getDbRuntimeConfig().defaults;
    const staleTime = config.staleTime ?? defaults?.staleTime ?? 0;
    const emptyStaleTime = config.emptyStaleTime ?? defaults?.emptyStaleTime;
    if (emptyStaleTime == null) return staleTime;
    return query => (query.state.dataUpdatedAt > 0 && isEmpty(query.state.data as TSelected) ? emptyStaleTime : staleTime);
  };

  const execute = async (input: TInput): Promise<TSelected> => {
    const generationFence = createGenerationFence();
    let data: TData;
    try {
      if (config.fetcher) {
        data = await config.fetcher(input);
      } else {
        const variables = config.vars?.(input) ?? {};
        data = (await getDbTransport().query({ query: config.document, variables })).data as TData;
      }
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'query', key: config.key });
      } catch (observerError) {
        getDbLogger().error('defineFetch onSyncError failed', { error: observerError });
      }
      throw error;
    }
    if (!generationFence.isCurrent()) {
      throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    }
    return config.select(data);
  };

  const fetch = async (input: TInput): Promise<TSelected> => {
    const generationFence = createGenerationFence();
    try {
      return await getInternalQueryClient().fetchQuery<TSelected>({
        queryKey: queryKeyOf(input),
        queryFn: () => execute(input),
        staleTime: resolveStaleTime(),
        gcTime: config.gcTime ?? getDbRuntimeConfig().defaults?.gcTime
      });
    } catch (error) {
      if (!generationFence.isCurrent()) {
        throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
      }
      throw error;
    }
  };

  const remove = (): void => {
    getInternalQueryClient().removeQueries({ queryKey: ['dbl-fetch', config.key] });
  };

  const use = (input: TInput): FetchResult<TSelected> => {
    const enabled = config.enabled ? config.enabled(input) : true;
    const request = useQuery({
      queryKey: queryKeyOf(input),
      enabled,
      queryFn: () => execute(input),
      staleTime: resolveStaleTime(),
      gcTime: config.gcTime ?? getDbRuntimeConfig().defaults?.gcTime
    });
    const hasData = Array.isArray(request.data) ? request.data.length > 0 : request.data !== undefined;
    const phase = computePhase({
      isInactive: !enabled && !hasData,
      isRestoring: false,
      isSyncReady: true,
      isFetching: request.isFetching,
      hasData,
      isRefreshing: request.isRefetching,
      isFetchingNextPage: false,
      isError: request.error != null,
      hasFetchedData: request.isFetched
    });
    const loadingState = useMemo(() => computeLoadingState(phase, hasData), [phase, hasData]);
    const refetch = useCallback(() => {
      void request.refetch();
    }, [request.refetch]);
    return useMemo(() => ({ data: request.data, loadingState, error: request.error, refetch }), [request.data, loadingState, request.error, refetch]);
  };

  return { use, fetch, remove };
};
