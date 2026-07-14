"use strict";

import { useQuery } from '@tanstack/react-query';
import { computeLoadingState } from "../queries/base/loadingState.js";
import { getDbRuntimeConfig } from "./configure.js";
import { stableSerialize } from "../core/serialize.js";
const nodesOf = value => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value == null ? [] : [value];
  const connection = value;
  return connection.nodes ?? connection.edges?.flatMap(edge => edge.node == null ? [] : [edge.node]) ?? [value];
};

/** Define a query that compiles selected GraphQL data into a model or scope apply operation. */
export const defineQuery = config => {
  const fetch = async scope => {
    if (config.enabled && !config.enabled(scope)) return;
    const data = (await getDbRuntimeConfig().transport.query({
      query: config.document,
      variables: config.vars?.(scope)
    })).data;
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const rows = nodesOf(selected);
    if ('__apply' in config.into && typeof config.into.__apply === 'function') {
      config.into.__apply(scope, rows, config.coverage ?? (config.page ? 'page' : 'complete'));
    } else {
      config.into.__applyRows?.(rows);
    }
  };
  return {
    fetch,
    invalidate: scope => {
      getDbRuntimeConfig().queryClient?.invalidateQueries({
        queryKey: ['dblayer', config.document, scope === undefined ? undefined : stableSerialize(scope)]
      });
    },
    use: scope => {
      const request = useQuery({
        queryKey: ['dblayer', config.document, stableSerialize(scope)],
        queryFn: () => fetch(scope),
        enabled: config.enabled?.(scope) ?? true,
        staleTime: getDbRuntimeConfig().defaults?.staleTime,
        gcTime: getDbRuntimeConfig().defaults?.gcTime
      });
      const rows = '__apply' in config.into && typeof config.into.__apply === 'function' ? config.into.use(scope) : undefined;
      return {
        data: rows,
        loadingState: computeLoadingState(request.isFetching ? 'initial_loading' : request.error ? 'error' : 'ready', Array.isArray(rows) && rows.length > 0),
        error: request.error,
        hasNextPage: false,
        isFetchingNextPage: false,
        loadMore: () => {
          void request.refetch();
        },
        refetch: async () => {
          await request.refetch();
        }
      };
    }
  };
};
//# sourceMappingURL=defineQuery.js.map