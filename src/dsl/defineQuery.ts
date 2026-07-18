import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { DocumentNode, OperationDefinitionNode } from 'graphql';
import type { DbGraphQLDocument, LoadingState } from '../types';
import { computeLoadingState, computePhase } from '../queries/base/loadingState';
import type { JournalOp } from '../core/apply/journal';
import { buildScopeKey } from '../core/compileDbWhere';
import { registerModelInvalidation } from '../core/invalidationRegistry';
import { getApplyRuntime, getDbRuntimeConfig, getRuntimeGeneration } from './configure';
import { getDbLogger } from '../core/logger';
import type { ScopeHandle } from './defineModel';
import type { Coverage } from './scope';

type PageInfoLike = { hasNextPage?: boolean; endCursor?: string | null; hasPreviousPage?: boolean; startCursor?: string | null };
type ConnectionLike = { nodes?: unknown[]; edges?: Array<{ node?: unknown } & Record<string, unknown>>; pageInfo?: PageInfoLike };

/** Reactive result of `query.use(scope)`: fetch/pagination status plus the destination's reactive read. */
export type QueryResult<T> = {
  /** Reactive read of the write destination (`config.into`); `undefined` before any successful write. */
  data: T[] | T | undefined;
  /** UI loading-state machine derived from fetch status and whether `data` has rows. */
  loadingState: LoadingState;
  /** The last fetch/next-page error, or `null`. Cleared on the next successful fetch. */
  error: Error | null;
  /** `true` when another page is available. Always `false` for single (non-`page`) queries. */
  hasNextPage: boolean;
  /** `true` while a next-page fetch is in flight. Always `false` for single (non-`page`) queries. */
  isFetchingNextPage: boolean;
  /**
   * Fetch and apply the next page over the network (TanStack Query `fetchNextPage`). A no-op for single
   * (non-`page`) queries. This is server-side pagination - a DIFFERENT concept from a scope's
   * `ScopeHandle.useWindow(...).fetchNextPage`, which grows how many already-synced local rows are
   * rendered without touching the network. Both surfaces share the `fetchNextPage` name (network pages
   * vs local window); a paginated list typically wires both.
   */
  fetchNextPage: () => void;
  /** Re-run the query from the first page, replacing `data`. */
  refetch: () => Promise<void>;
};

type PlanRowsSink = { modelId: string; __planRows?: (rows: unknown[]) => JournalOp[] };

export type ExtractSink = { into: PlanRowsSink; rows: unknown[] };

type ScopeDestination<TStored, TScope> = ScopeHandle<TStored & { id: string }, TScope>;
type ModelDestination<TStored> = { modelId: string; __planRows?: (rows: TStored[]) => JournalOp[]; get?: (id: string | null | undefined) => TStored | undefined };
type QueryDestination<TStored, TScope> = ScopeDestination<TStored, TScope> | ModelDestination<TStored>;

type QueryConfig<TResponse, TVars, TScope, TStored> = {
  /** The GraphQL query document. `TResponse`/`TVars` flow from a `TypedDocumentNode`. */
  document: DbGraphQLDocument<TResponse, TVars>;
  /** Stable cache-key namespace; defaults to the document's operation name. */
  key?: string;
  /** Derive GraphQL variables from the scope value passed to `query.use(scope)`/`query.fetch(scope)`. */
  vars?: (scope: TScope) => TVars;
  /**
   * Infinite connection selector: pick the `{ nodes | edges, pageInfo }` connection off the response for
   * cursor pagination. Mutually exclusive with `select` - setting `page` makes `query.use` an
   * infinite-query hook (`QueryResult.hasNextPage`/`fetchNextPage` become live); omitting it makes `query.use`
   * a single-fetch hook.
   */
  page?: (data: TResponse) => ConnectionLike;
  /** Non-paginated payload selector for single-fetch queries. Mutually exclusive with `page`. */
  select?: (data: TResponse) => unknown;
  /** Write destination: a model's `ScopeHandle` (scoped write, membership tracking) or a model directly. */
  into: QueryDestination<TStored, TScope>;
  /** Membership reconciliation mode for scope destinations. Defaults to `'page'` when `page` is set, else `'complete'`. */
  coverage?: Coverage;
  /** Edge payload for scope entries; receives the connection edge object (or the node for plain lists). */
  edge?: (edgeSource: unknown) => Record<string, unknown> | undefined;
  /** Cross-model sideloads applied in the SAME transaction as the main rows. */
  extract?: (ctx: { data: TResponse; nodes: unknown[] }) => ExtractSink[];
  /** Transform the selected/paged payload before it is split into nodes and written. Runs after `select`/`page`. */
  map?: (selected: unknown) => unknown;
  /** Gate network execution per scope value; `false` skips fetching while local reads stay live. Defaults to always enabled. */
  enabled?: (scope: TScope) => boolean;
  /** Freshness window (ms) before a scope with data is considered stale and refetched. Passed to TanStack Query unchanged. */
  staleTime?: number;
  /** Freshness window (ms) used instead of `staleTime` only when the last fetch for a scope returned zero rows. */
  emptyStaleTime?: number;
  /** TanStack Query cache garbage-collection time (ms) for this query's cache entries. */
  gcTime?: number;
  /** Bounded page window retained by the underlying `useInfiniteQuery`; older pages are dropped past this count. */
  maxPages?: number;
  /** Whether TanStack Query refetches on hook remount. Defaults to the TanStack Query default. */
  refetchOnMount?: boolean;
  /** Cursor pagination direction; `'backward'` reads `hasPreviousPage`/`startCursor` instead of the forward pair. */
  direction?: 'forward' | 'backward';
  /** GraphQL variable carrying the page cursor; defaults to 'after' ('before' when backward). */
  cursorVar?: string;
  /** Override cursor extraction from a page; defaults to reading `pageInfo.endCursor`/`startCursor` per `direction`. */
  getCursor?: (page: ConnectionLike) => string | null;
  /** Transform the raw string cursor before it is substituted into the cursor variable (e.g. Number for numeric cursors). */
  mapCursor?: (cursor: string) => unknown;
};

type PageMeta = { endCursor: string | null; hasNextPage: boolean; count: number };

const operationKey = (document: DbGraphQLDocument<any, any>, override?: string): string => {
  if (override) return override;
  const operation = (document as DocumentNode).definitions?.find(
    (definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition'
  );
  const name = operation?.name?.value;
  if (!name) throw new Error('defineQuery requires a named operation or an explicit key');
  return name;
};

const nodePairsOf = (value: unknown): Array<{ node: unknown; edgeSource: unknown }> => {
  if (Array.isArray(value)) return value.map(node => ({ node, edgeSource: node }));
  if (!value || typeof value !== 'object') return value == null ? [] : [{ node: value, edgeSource: value }];
  const connection = value as ConnectionLike;
  if (connection.nodes) return connection.nodes.map(node => ({ node, edgeSource: node }));
  if (connection.edges) return connection.edges.flatMap(edge => (edge.node == null ? [] : [{ node: edge.node, edgeSource: edge }]));
  return [{ node: value, edgeSource: value }];
};

const isScopeDestination = (into: unknown): into is ScopeHandle<any, any> =>
  typeof (into as { __planApply?: unknown })?.__planApply === 'function';

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
export const defineQuery = <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>) => {
  const keyName = operationKey(config.document, config.key);
  const queryKeyOf = (scope: TScope): unknown[] => ['dbl', keyName, buildScopeKey(scope)];
  const registeredScopes = new Map<string, TScope>();
  const registerScope = (scope: TScope): void => {
    registeredScopes.set(buildScopeKey(scope), scope);
  };
  const matchesPartialScope = (scope: TScope, partial: TScope): boolean => {
    if (partial == null || typeof partial !== 'object' || Array.isArray(partial)) return Object.is(scope, partial);
    if (scope == null || typeof scope !== 'object' || Array.isArray(scope)) return false;
    return Object.entries(partial as Record<string, unknown>).every(([key, value]) => Object.is((scope as Record<string, unknown>)[key], value));
  };
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');

  const pageMetaOf = (connection: ConnectionLike | null): PageMeta => {
    if (!connection) return { endCursor: null, hasNextPage: false, count: 0 };
    const info = connection.pageInfo ?? {};
    const backward = config.direction === 'backward';
    const cursor = config.getCursor ? config.getCursor(connection) : backward ? (info.startCursor ?? null) : (info.endCursor ?? null);
    const hasNextPage = backward ? (info.hasPreviousPage ?? false) : (info.hasNextPage ?? false);
    const count = connection.nodes?.length ?? connection.edges?.length ?? 0;
    return { endCursor: cursor, hasNextPage, count };
  };

  const applyResponse = (scope: TScope, data: TResponse, resetOrder: boolean): PageMeta => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : (data as unknown);
    const mapped = config.map ? config.map(selected) : selected;
    const pairs = nodePairsOf(mapped);
    const nodes = pairs.map(pair => pair.node);
    const ops: JournalOp[] = [];
    if (isScopeDestination(config.into)) {
      const scopeRows = pairs.map(pair => ({ row: pair.node as TStored & { id: string }, edge: config.edge?.(pair.edgeSource) }));
      ops.push(...(config.into.__planApply?.(scope, scopeRows, coverage, { resetOrder }) ?? []));
    } else {
      ops.push(...(config.into.__planRows?.(nodes as TStored[]) ?? []));
    }
    for (const sink of config.extract?.({ data, nodes }) ?? []) {
      ops.push(...(sink.into.__planRows?.(sink.rows) ?? []));
    }
    if (ops.length > 0) getApplyRuntime().apply(ops);
    return pageMetaOf(config.page ? config.page(data) : null);
  };

  const runFetch = async (scope: TScope, cursor: string | null): Promise<PageMeta> => {
    const cursorVar = config.cursorVar ?? (config.direction === 'backward' ? 'before' : 'after');
    const variables = { ...((config.vars?.(scope) ?? {}) as Record<string, unknown>), ...(cursor != null ? { [cursorVar]: config.mapCursor ? config.mapCursor(cursor) : cursor } : {}) };
    const generation = getRuntimeGeneration();
    let data: TResponse;
    try {
      data = (await getDbRuntimeConfig().transport.query({ query: config.document, variables: variables as TVars })).data as TResponse;
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try { getDbRuntimeConfig().defaults?.onSyncError?.(reported, { source: 'query', model: destinationModelId, key: keyName }); } catch (observerError) { getDbLogger().error('defineQuery onSyncError failed', { error: observerError }); }
      throw error;
    }
    if (generation !== getRuntimeGeneration()) return { endCursor: null, hasNextPage: false, count: 0 };
    return applyResponse(scope, data, cursor == null);
  };

  const fetch = async (scope: TScope): Promise<void> => {
    registerScope(scope);
    if (config.enabled && !config.enabled(scope)) return;
    await runFetch(scope, null);
  };

  const invalidate = (scope?: TScope): void => {
    const client = getDbRuntimeConfig().queryClient;
    if (!client) return;
    if (scope === undefined) {
      void client.invalidateQueries({ queryKey: ['dbl', keyName] });
      return;
    }
    registerScope(scope);
    for (const registeredScope of registeredScopes.values()) {
      if (matchesPartialScope(registeredScope, scope)) void client.invalidateQueries({ queryKey: queryKeyOf(registeredScope) });
    }
  };
  const destinationModelId = (config.into as { modelId?: string }).modelId;
  if (destinationModelId) registerModelInvalidation(destinationModelId, scope => invalidate(scope as TScope | undefined));

  const isEmptyMeta = (data: unknown): boolean => {
    if (data == null) return true;
    if (typeof data === 'object' && 'pages' in (data as Record<string, unknown>)) {
      return ((data as { pages: PageMeta[] }).pages ?? []).every(page => page.count === 0);
    }
    return (data as PageMeta).count === 0;
  };

  const resolveStaleTime = (): number | ((query: { state: { data: unknown } }) => number) => {
    const defaults = getDbRuntimeConfig().defaults;
    const base = config.staleTime ?? defaults?.staleTime ?? 0;
    const empty = config.emptyStaleTime ?? defaults?.emptyStaleTime;
    if (empty == null) return base;
    return query => (isEmptyMeta(query.state.data) ? empty : base);
  };

  const useDestinationRows: (scope: TScope) => TStored[] | undefined = isScopeDestination(config.into)
    ? scope => (config.into as ScopeDestination<TStored, TScope>).use(scope) as TStored[]
    : () => undefined;

  const buildResult = (
    rows: TStored[] | undefined,
    flags: { enabled: boolean; isFetching: boolean; isRefetching: boolean; isFetchingNextPage: boolean; isFetched: boolean; error: Error | null; hasNextPage: boolean; fetchNextPage: () => void; refetch: () => Promise<void> }
  ): QueryResult<TStored> => {
    const hasData = Array.isArray(rows) ? rows.length > 0 : rows !== undefined;
    const phase = computePhase({
      isInactive: !flags.enabled && !hasData,
      isRestoring: false,
      isSyncReady: true,
      isFetching: flags.isFetching,
      hasData,
      isRefreshing: flags.isRefetching,
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

  const useInfiniteResult = (scope: TScope, options?: { enabled?: boolean }): QueryResult<TStored> => {
    registerScope(scope);
    const enabled = (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const request = useInfiniteQuery({
      queryKey: queryKeyOf(scope),
      enabled,
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }) => runFetch(scope, pageParam),
      getNextPageParam: (last: PageMeta) => (last.hasNextPage && last.endCursor != null ? last.endCursor : undefined),
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
      error: (request.error as Error | null) ?? null,
      hasNextPage: request.hasNextPage,
      fetchNextPage: () => {
        void request.fetchNextPage();
      },
      refetch: async () => {
        await request.refetch();
      }
    });
  };

  const useSingleResult = (scope: TScope, options?: { enabled?: boolean }): QueryResult<TStored> => {
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
      error: (request.error as Error | null) ?? null,
      hasNextPage: false,
      fetchNextPage: () => {},
      refetch: async () => {
        await request.refetch();
      }
    });
  };

  return { use: config.page ? useInfiniteResult : useSingleResult, fetch, invalidate };
};
