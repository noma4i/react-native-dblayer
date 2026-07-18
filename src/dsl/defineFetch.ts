import { useQuery } from '../queryRuntime';
import type { DbGraphQLDocument, LoadingState } from '../types';
import { computeLoadingState, computePhase } from '../queries/base/loadingState';
import { buildScopeKey } from '../core/compileDbWhere';
import { getDbTransport } from '../core/transport';
import { getDbLogger } from '../core/logger';
import { createGenerationFence } from '../utils/runtimePrimitives';
import { getDbRuntimeConfig } from './configure';

type FetchConfig<TData, TInput, TSelected> = {
  /** The GraphQL query document. `TData` flows from a `TypedDocumentNode`. */
  document: DbGraphQLDocument<TData, Record<string, unknown>>;
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
  /** TanStack Query cache garbage-collection time (ms). Defaults to `DbDefaults.gcTime`. */
  gcTime?: number;
};

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
 * Define an ephemeral, store-free GraphQL fetch: runs a query, selects a payload, and exposes it through
 * a reactive TanStack Query-backed hook plus an imperative call. Unlike `defineQuery`, there is no `into`
 * destination - the response never reaches the apply pipeline, never writes a journal record, and never
 * touches a `dbl:` storage key. Use it for display-only data with no local reactive read of its own
 * (pricing tables, country lists, SKU catalogs) where a `defineQuery` write destination would be pure
 * overhead.
 *
 * @param config Document, cache key, `select`, and optional `vars`/`enabled`/`staleTime`/`gcTime`.
 * @returns `{ use, fetch }`. `use(input)` is a hook returning a `FetchResult`. `fetch(input)` runs one
 * fetch outside React and resolves to the selected payload, throwing on transport failure.
 */
export const defineFetch = <TData, TInput = void, TSelected = TData>(config: FetchConfig<TData, TInput, TSelected>) => {
  const queryKeyOf = (input: TInput): unknown[] => ['dbl-fetch', config.key, buildScopeKey(input)];

  const fetch = async (input: TInput): Promise<TSelected> => {
    const variables = config.vars?.(input) ?? {};
    const generationFence = createGenerationFence();
    let data: TData;
    try {
      data = (await getDbTransport().query({ query: config.document, variables })).data as TData;
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

  const use = (input: TInput): FetchResult<TSelected> => {
    const enabled = config.enabled ? config.enabled(input) : true;
    const request = useQuery({
      queryKey: queryKeyOf(input),
      enabled,
      queryFn: () => fetch(input),
      staleTime: config.staleTime ?? getDbRuntimeConfig().defaults?.staleTime ?? 0,
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
    return {
      data: request.data,
      loadingState: computeLoadingState(phase, hasData),
      error: request.error,
      refetch: () => {
        void request.refetch();
      }
    };
  };

  return { use, fetch };
};
