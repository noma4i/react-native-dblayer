"use strict";

import { useQuery } from "../queryRuntime.js";
import { computeLoadingState, computePhase } from "../queries/base/loadingState.js";
import { buildScopeKey } from "../core/compileDbWhere.js";
import { getDbTransport } from "../core/transport.js";
import { getDbLogger } from "../core/logger.js";
import { createGenerationFence } from "../utils/runtimePrimitives.js";
import { getDbRuntimeConfig } from "./configure.js";

/** Reactive result of `fetchQuery.use(input)`. */

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
export const defineFetch = config => {
  const queryKeyOf = input => ['dbl-fetch', config.key, buildScopeKey(input)];
  const fetch = async input => {
    const variables = config.vars?.(input) ?? {};
    const generationFence = createGenerationFence();
    let data;
    try {
      data = (await getDbTransport().query({
        query: config.document,
        variables
      })).data;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'query',
          key: config.key
        });
      } catch (observerError) {
        getDbLogger().error('defineFetch onSyncError failed', {
          error: observerError
        });
      }
      throw error;
    }
    if (!generationFence.isCurrent()) {
      throw new Error('react-native-dblayer: defineFetch response dropped - runtime was reset before it resolved');
    }
    return config.select(data);
  };
  const use = input => {
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
  return {
    use,
    fetch
  };
};
//# sourceMappingURL=defineFetch.js.map