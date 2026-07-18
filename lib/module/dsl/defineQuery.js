"use strict";

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { computeLoadingState, computePhase } from "../queries/base/loadingState.js";
import { buildScopeKey } from "../core/compileDbWhere.js";
import { registerModelInvalidation } from "../core/invalidationRegistry.js";
import { createGenerationFence } from "../utils/runtimePrimitives.js";
import { isNonArrayRecord, isRecord } from "../utils/normalizeHelpers.js";
import { getApplyRuntime, getDbRuntimeConfig } from "./configure.js";
import { getDbLogger } from "../core/logger.js";

/** Reactive result of `query.use(scope)`: fetch/pagination status plus the destination's reactive read. */

const operationKey = (document, override) => {
  if (override) return override;
  const operation = document.definitions?.find(definition => definition.kind === 'OperationDefinition');
  const name = operation?.name?.value;
  if (!name) throw new Error('defineQuery requires a named operation or an explicit key');
  return name;
};
const nodePairsOf = value => {
  if (Array.isArray(value)) return value.map(node => ({
    node,
    edgeSource: node
  }));
  if (!isRecord(value)) return value == null ? [] : [{
    node: value,
    edgeSource: value
  }];
  const connection = value;
  if (connection.nodes) return connection.nodes.map(node => ({
    node,
    edgeSource: node
  }));
  if (connection.edges) return connection.edges.flatMap(edge => edge.node == null ? [] : [{
    node: edge.node,
    edgeSource: edge
  }]);
  return [{
    node: value,
    edgeSource: value
  }];
};
const isScopeDestination = into => typeof into?.__planApply === 'function';

/**
 * Define a query that runs a GraphQL document, compiles the response into one apply-pipeline transaction
 * (writing rows into `config.into` and any `extract` sinks atomically), and exposes a reactive TanStack
 * Query-backed hook plus imperative fetch/invalidate.
 *
 * @param config Document, variables, response selection (`select` or `page`), write destination, and
 * pagination/freshness options.
 * @returns `{ use, fetch, invalidate }`. `use(scope, opts?)` is a hook - a single-fetch hook when `page` is
 * omitted, an infinite-query hook (paginated) when `page` is set - returning a `QueryResult`. `fetch(scope)`
 * runs one fetch outside React. `invalidate(scope?)` clears the React Query cache for one scope, or every
 * registered scope when `scope` is omitted.
 */
export const defineQuery = config => {
  const keyName = operationKey(config.document, config.key);
  const queryKeyOf = scope => ['dbl', keyName, buildScopeKey(scope)];
  const registeredScopes = new Map();
  const registerScope = scope => {
    registeredScopes.set(buildScopeKey(scope), scope);
  };
  const matchesPartialScope = (scope, partial) => {
    if (!isNonArrayRecord(partial)) return Object.is(scope, partial);
    if (!isNonArrayRecord(scope)) return false;
    return Object.entries(partial).every(([key, value]) => Object.is(scope[key], value));
  };
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const pageMetaOf = connection => {
    if (!connection) return {
      endCursor: null,
      hasNextPage: false,
      count: 0
    };
    const info = connection.pageInfo ?? {};
    const backward = config.direction === 'backward';
    const cursor = config.getCursor ? config.getCursor(connection) : backward ? info.startCursor ?? null : info.endCursor ?? null;
    const hasNextPage = backward ? info.hasPreviousPage ?? false : info.hasNextPage ?? false;
    const count = connection.nodes?.length ?? connection.edges?.length ?? 0;
    return {
      endCursor: cursor,
      hasNextPage,
      count
    };
  };
  const applyResponse = (scope, data, resetOrder) => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const mapped = config.map ? config.map(selected) : selected;
    const pairs = nodePairsOf(mapped);
    const nodes = pairs.map(pair => pair.node);
    const ops = [];
    if (isScopeDestination(config.into)) {
      const scopeRows = pairs.map(pair => ({
        row: pair.node,
        edge: config.edge?.(pair.edgeSource)
      }));
      ops.push(...(config.into.__planApply?.(scope, scopeRows, coverage, {
        resetOrder
      }) ?? []));
    } else {
      ops.push(...(config.into.__planRows?.(nodes) ?? []));
    }
    for (const sink of config.extract?.({
      data,
      nodes
    }) ?? []) {
      ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
    }
    if (ops.length > 0) getApplyRuntime().apply(ops);
    return pageMetaOf(config.page ? config.page(data) : null);
  };
  const runFetch = async (scope, cursor) => {
    const cursorVar = config.cursorVar ?? (config.direction === 'backward' ? 'before' : 'after');
    const variables = {
      ...(config.vars?.(scope) ?? {}),
      ...(cursor != null ? {
        [cursorVar]: config.mapCursor ? config.mapCursor(cursor) : cursor
      } : {})
    };
    const generationFence = createGenerationFence();
    let data;
    try {
      data = (await getDbRuntimeConfig().transport.query({
        query: config.document,
        variables: variables
      })).data;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults?.onSyncError?.(reported, {
          source: 'query',
          model: destinationModelId,
          key: keyName
        });
      } catch (observerError) {
        getDbLogger().error('defineQuery onSyncError failed', {
          error: observerError
        });
      }
      throw error;
    }
    if (!generationFence.isCurrent()) return {
      endCursor: null,
      hasNextPage: false,
      count: 0
    };
    return applyResponse(scope, data, cursor == null);
  };
  const fetch = async scope => {
    registerScope(scope);
    if (config.enabled && !config.enabled(scope)) return;
    await runFetch(scope, null);
  };
  const invalidate = scope => {
    const client = getDbRuntimeConfig().queryClient;
    if (!client) return;
    if (scope === undefined) {
      void client.invalidateQueries({
        queryKey: ['dbl', keyName]
      });
      return;
    }
    registerScope(scope);
    for (const registeredScope of registeredScopes.values()) {
      if (matchesPartialScope(registeredScope, scope)) void client.invalidateQueries({
        queryKey: queryKeyOf(registeredScope)
      });
    }
  };
  const destinationModelId = config.into.modelId;
  if (destinationModelId) registerModelInvalidation(destinationModelId, scope => invalidate(scope));
  const isEmptyMeta = data => {
    if (data == null) return true;
    if (isRecord(data) && 'pages' in data) {
      return (data.pages ?? []).every(page => page.count === 0);
    }
    return data.count === 0;
  };
  const resolveStaleTime = () => {
    const defaults = getDbRuntimeConfig().defaults;
    const base = config.staleTime ?? defaults?.staleTime ?? 0;
    const empty = config.emptyStaleTime ?? defaults?.emptyStaleTime;
    if (empty == null) return base;
    return query => isEmptyMeta(query.state.data) ? empty : base;
  };
  const useDestinationRows = isScopeDestination(config.into) ? scope => config.into.use(scope) : () => undefined;
  const buildResult = (rows, flags) => {
    const hasData = Array.isArray(rows) ? rows.length > 0 : rows !== undefined;
    const phase = computePhase({
      isInactive: !flags.enabled && !hasData,
      isRestoring: false,
      isSyncReady: true,
      isFetching: flags.isFetching,
      hasData,
      isRefreshing: flags.isRefetching || flags.isFetching && hasData && !flags.isFetchingNextPage,
      isFetchingNextPage: flags.isFetchingNextPage,
      isError: flags.error != null,
      hasFetchedData: flags.isFetched
    });
    return {
      data: rows,
      loadingState: computeLoadingState(phase, hasData),
      error: flags.error,
      hasNextPage: flags.hasNextPage,
      isFetchingNextPage: flags.isFetchingNextPage,
      fetchNextPage: flags.fetchNextPage,
      refetch: flags.refetch
    };
  };
  const useInfiniteResult = (scope, options) => {
    registerScope(scope);
    const enabled = (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const request = useInfiniteQuery({
      queryKey: queryKeyOf(scope),
      enabled,
      initialPageParam: null,
      queryFn: ({
        pageParam
      }) => runFetch(scope, pageParam),
      getNextPageParam: last => last.hasNextPage && last.endCursor != null ? last.endCursor : undefined,
      maxPages: config.maxPages,
      staleTime: resolveStaleTime(),
      gcTime: config.gcTime ?? getDbRuntimeConfig().defaults?.gcTime,
      refetchOnMount: config.refetchOnMount
    });
    const rows = useDestinationRows(scope);
    return buildResult(rows, {
      enabled,
      isFetching: request.isFetching,
      isRefetching: request.isRefetching,
      isFetchingNextPage: request.isFetchingNextPage,
      isFetched: request.isFetched,
      error: request.error ?? null,
      hasNextPage: request.hasNextPage,
      fetchNextPage: () => {
        void request.fetchNextPage();
      },
      refetch: async () => {
        await request.refetch();
      }
    });
  };
  const useSingleResult = (scope, options) => {
    registerScope(scope);
    const enabled = (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const request = useQuery({
      queryKey: queryKeyOf(scope),
      enabled,
      queryFn: () => runFetch(scope, null),
      staleTime: resolveStaleTime(),
      gcTime: config.gcTime ?? getDbRuntimeConfig().defaults?.gcTime,
      refetchOnMount: config.refetchOnMount
    });
    const rows = useDestinationRows(scope);
    return buildResult(rows, {
      enabled,
      isFetching: request.isFetching,
      isRefetching: request.isRefetching,
      isFetchingNextPage: false,
      isFetched: request.isFetched,
      error: request.error ?? null,
      hasNextPage: false,
      fetchNextPage: () => {},
      refetch: async () => {
        await request.refetch();
      }
    });
  };
  return {
    use: config.page ? useInfiniteResult : useSingleResult,
    fetch,
    invalidate
  };
};
//# sourceMappingURL=defineQuery.js.map