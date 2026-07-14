"use strict";

import { useCallback, useEffect, useState } from 'react';
import { computeLoadingState } from "../queries/base/loadingState.js";
import { getDbRuntimeConfig } from "./configure.js";
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
    invalidate: _scope => {},
    use: scope => {
      const [error, setError] = useState(null);
      const [isFetching, setFetching] = useState(false);
      const run = useCallback(async () => {
        setFetching(true);
        setError(null);
        try {
          await fetch(scope);
        } catch (nextError) {
          setError(nextError);
        } finally {
          setFetching(false);
        }
      }, [scope]);
      useEffect(() => {
        void run();
      }, [run]);
      const rows = '__apply' in config.into && typeof config.into.__apply === 'function' ? config.into.use(scope) : undefined;
      return {
        data: rows,
        loadingState: computeLoadingState(isFetching ? 'initial_loading' : error ? 'error' : 'ready', Array.isArray(rows) && rows.length > 0),
        error,
        hasNextPage: false,
        isFetchingNextPage: false,
        loadMore: () => {
          void run();
        },
        refetch: run
      };
    }
  };
};
//# sourceMappingURL=defineQuery.js.map