"use strict";

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { computeLoadingState, computePhase } from "../queries/base/loadingState.js";
import { buildScopeKey } from "../core/compileDbWhere.js";
import { getDbTransport } from "../core/transport.js";
import { getDbLogger } from "../core/logger.js";
import { createGenerationFence } from "../utils/runtimePrimitives.js";
import { getDbRuntimeConfig, getInternalQueryClient } from "./configure.js";

/** Reactive result of `fetchQuery.use(input)`. */

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
export const defineFetch = config => {
  const queryKeyOf = input => ['dbl-fetch', config.key, buildScopeKey(input)];
  const hasDocument = config.document !== undefined;
  const hasFetcher = config.fetcher !== undefined;
  if (hasDocument === hasFetcher) throw new Error('defineFetch requires exactly one of document or fetcher');
  const isEmpty = config.isEmpty ?? (data => data == null || Array.isArray(data) && data.length === 0);
  const resolveStaleTime = () => {
    const defaults = getDbRuntimeConfig().defaults;
    const staleTime = config.staleTime ?? defaults?.staleTime ?? 0;
    const emptyStaleTime = config.emptyStaleTime ?? defaults?.emptyStaleTime;
    if (emptyStaleTime == null) return staleTime;
    return query => query.state.dataUpdatedAt > 0 && isEmpty(query.state.data) ? emptyStaleTime : staleTime;
  };
  const execute = async input => {
    const generationFence = createGenerationFence();
    let data;
    try {
      if (config.fetcher) {
        data = await config.fetcher(input);
      } else {
        const variables = config.vars?.(input) ?? {};
        data = (await getDbTransport().query({
          query: config.document,
          variables
        })).data;
      }
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
  const fetch = async input => {
    const generationFence = createGenerationFence();
    try {
      return await getInternalQueryClient().fetchQuery({
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
  const remove = () => {
    getInternalQueryClient().removeQueries({
      queryKey: ['dbl-fetch', config.key]
    });
  };
  const use = input => {
    const enabled = config.enabled ? config.enabled(input) : true;
    const request = useQuery({
      queryKey: queryKeyOf(input),
      enabled,
      queryFn: () => execute(input),
      staleTime: resolveStaleTime(),
      gcTime: config.gcTime ?? getDbRuntimeConfig().defaults?.gcTime
    });
    const hasData = request.data !== undefined && !isEmpty(request.data);
    const phaseInput = {
      isInactive: !enabled && !hasData,
      isFetching: request.isFetching,
      committedRowsDied: false,
      isPaused: request.fetchStatus === 'paused',
      retryAttempt: request.failureCount ?? 0,
      hasData,
      isRefreshing: request.isRefetching,
      isFetchingNextPage: false,
      isError: request.error != null,
      hasFetchedData: request.isFetched
    };
    const phase = computePhase(phaseInput);
    const loadingState = useMemo(() => computeLoadingState(phase, phaseInput), [phase, phaseInput.hasData, phaseInput.isFetching, phaseInput.isPaused, phaseInput.retryAttempt]);
    const refetch = useCallback(() => {
      void request.refetch();
    }, [request.refetch]);
    return useMemo(() => ({
      data: request.data,
      loadingState,
      error: request.error,
      refetch
    }), [request.data, loadingState, request.error, refetch]);
  };
  return {
    use,
    fetch,
    remove
  };
};
//# sourceMappingURL=defineFetch.js.map