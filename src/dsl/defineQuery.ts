import { useQuery } from '@tanstack/react-query';
import type { DbGraphQLDocument, LoadingState } from '../types';
import { computeLoadingState } from '../queries/base/loadingState';
import type { ScopeHandle } from './defineModel';
import type { Coverage } from './scope';
import { getDbRuntimeConfig } from './configure';
import { stableSerialize } from '../core/serialize';

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
    invalidate: (scope?: TScope) => {
      getDbRuntimeConfig().queryClient?.invalidateQueries({ queryKey: ['dblayer', config.document, scope === undefined ? undefined : stableSerialize(scope)] });
    },
    use: (scope: TScope): QueryResult<TStored> => {
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
        error: request.error as Error | null,
        hasNextPage: false,
        isFetchingNextPage: false,
        loadMore: () => { void request.refetch(); },
        refetch: async () => { await request.refetch(); }
      };
    }
  };
};
