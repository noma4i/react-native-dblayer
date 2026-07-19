import type { DbGraphQLDocument, LoadingState } from '../types';
import type { JournalOp } from '../core/apply/journal';
import type { ScopeHandle } from './defineModel';
import type { ScopeCoverage } from './scope';
type PageInfoLike = {
    hasNextPage?: boolean;
    endCursor?: string | null;
    hasPreviousPage?: boolean;
    startCursor?: string | null;
};
type ConnectionLike = {
    nodes?: unknown[];
    edges?: Array<{
        node?: unknown;
    } & Record<string, unknown>>;
    pageInfo?: PageInfoLike;
};
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
type PlanRowsSink = {
    modelId: string;
    __planRows?: (rows: unknown[], options?: {
        includeMembership?: boolean;
    }) => JournalOp[];
};
export type ExtractSink = {
    into: PlanRowsSink;
    rows: unknown[];
};
type ScopeDestination<TStored, TScope> = ScopeHandle<TStored & {
    id: string;
}, TScope>;
type ModelDestination<TStored> = {
    modelId: string;
    __planRows?: (rows: TStored[], options?: {
        includeMembership?: boolean;
    }) => JournalOp[];
    get?: (id: string | null | undefined) => TStored | undefined;
};
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
    coverage?: ScopeCoverage;
    /** Edge payload for scope entries; receives the connection edge object (or the node for plain lists). */
    edge?: (edgeSource: unknown) => Record<string, unknown> | undefined;
    /** Cross-model sideloads applied in the SAME transaction as the main rows. */
    extract?: (ctx: {
        data: TResponse;
        nodes: unknown[];
    }) => ExtractSink[];
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
export declare const defineQuery: <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>) => {
    use: (scope: TScope, options?: {
        enabled?: boolean;
    }) => QueryResult<TStored>;
    fetch: (scope: TScope) => Promise<void>;
    invalidate: (scope?: TScope) => void;
};
export {};
//# sourceMappingURL=defineQuery.d.ts.map