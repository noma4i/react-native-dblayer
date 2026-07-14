import { useCallback, useEffect, useState } from 'react';
import type { DbGraphQLDocument, LoadingState } from '../types';
import { computeLoadingState } from '../queries/base/loadingState';
import type { ScopeHandle } from './defineModel';
import type { Coverage } from './scope';
import { getDbRuntimeConfig } from './configure';

type ConnectionLike = { nodes?: unknown[]; edges?: Array<{ node?: unknown }> };

export type QueryResult<T> = {
  data: T[] | T | undefined;
  loadingState: LoadingState;
  error: Error | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  loadMore: () => void;
  refetch: () => Promise<void>;
};

type QueryDestination<TStored, TScope> = ScopeHandle<TStored & { id: string }, TScope> | { __applyRows?: (rows: TStored[]) => void; get?: (id: string) => TStored | undefined };

type QueryConfig<TResponse, TVars, TScope, TStored> = {
  document: DbGraphQLDocument<TResponse, TVars>;
  vars?: (scope: TScope) => TVars;
  page?: (data: TResponse) => ConnectionLike;
  select?: (data: TResponse) => unknown;
  into: QueryDestination<TStored, TScope>;
  coverage?: Coverage;
  map?: (selected: unknown) => unknown;
  enabled?: (scope: TScope) => boolean;
};

const nodesOf = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value == null ? [] : [value];
  const connection = value as ConnectionLike;
  return connection.nodes ?? connection.edges?.flatMap(edge => edge.node == null ? [] : [edge.node]) ?? [value];
};

/** Define a query that compiles selected GraphQL data into a model or scope apply operation. */
export const defineQuery = <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>) => {
  const fetch = async (scope: TScope): Promise<void> => {
    if (config.enabled && !config.enabled(scope)) return;
    const data = (await getDbRuntimeConfig().transport.query({ query: config.document, variables: config.vars?.(scope) })).data;
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : data;
    const rows = nodesOf(selected) as TStored[];
    if ('__apply' in config.into && typeof config.into.__apply === 'function') {
      config.into.__apply(scope, rows as (TStored & { id: string })[], config.coverage ?? (config.page ? 'page' : 'complete'));
    } else {
      (config.into as { __applyRows?: (rows: TStored[]) => void }).__applyRows?.(rows);
    }
  };
  return {
    fetch,
    invalidate: (_scope?: TScope) => {},
    use: (scope: TScope): QueryResult<TStored> => {
      const [error, setError] = useState<Error | null>(null);
      const [isFetching, setFetching] = useState(false);
      const run = useCallback(async () => {
        setFetching(true);
        setError(null);
        try {
          await fetch(scope);
        } catch (nextError) {
          setError(nextError as Error);
        } finally {
          setFetching(false);
        }
      }, [scope]);
      useEffect(() => { void run(); }, [run]);
      const rows = '__apply' in config.into && typeof config.into.__apply === 'function' ? config.into.use(scope) : undefined;
      return {
        data: rows,
        loadingState: computeLoadingState(isFetching ? 'initial_loading' : error ? 'error' : 'ready', Array.isArray(rows) && rows.length > 0),
        error,
        hasNextPage: false,
        isFetchingNextPage: false,
        loadMore: () => { void run(); },
        refetch: run
      };
    }
  };
};
