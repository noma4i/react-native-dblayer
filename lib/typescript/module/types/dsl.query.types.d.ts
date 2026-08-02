import type { DbGraphQLDocument, LoadingState } from './db.types';
import type { ScopeCoverage } from './core.planes.scopeIndex.types';
import type { ScopeHandle } from './dsl.model.types';
import type { WindowPaginationBridge } from './dsl.pagination.types';
import type { WritePlan } from './dsl.writePlan.types';
/** GraphQL pageInfo subset the query DSL understands, in both pagination directions. */
export type PageInfoLike = {
    hasNextPage?: boolean;
    endCursor?: string | null;
    hasPreviousPage?: boolean;
    startCursor?: string | null;
};
/** A relay-style connection or plain node list, as tolerated by the query `page`/`select` seams. */
export type ConnectionLike = {
    nodes?: ReadonlyArray<unknown> | null;
    edges?: ReadonlyArray<({
        node?: unknown;
    } & Record<string, unknown>) | null | undefined> | null;
    pageInfo?: PageInfoLike | null;
};
export type RelationCursorPage = ConnectionLike & {
    relationCursor?: string | null;
};
/** Scope landing destination for query results. */
export type ScopeDestination<TStored, TScope> = ScopeHandle<TStored & {
    id: string;
}, TScope>;
/** Model landing destination for query results (row reads only, no scope membership). */
export type ModelDestination<TStored> = {
    modelId: string;
    find(id: string | null | undefined): TStored | undefined;
    use: {
        find(id: string | null | undefined, opts?: {
            renderKeys?: readonly (keyof TStored & string)[];
        }): TStored | undefined;
        byIds(ids: readonly string[] | null | undefined, opts?: {
            renderKeys?: readonly (keyof TStored & string)[];
        }): {
            rows: TStored[];
            byId: ReadonlyMap<string, TStored>;
        };
    };
};
/** Either landing destination accepted by `Model.query`'s `into`. */
export type QueryDestination<TStored, TScope> = ScopeDestination<TStored, TScope> | ModelDestination<TStored>;
/** Full `Model.query` configuration: document, landing, pagination and freshness policy. */
export type QueryConfig<TResponse, TVars, TScope, TStored> = {
    document: DbGraphQLDocument<TResponse, TVars>;
    key?: string;
    /** Version of the persisted query metadata contract. Increment when destination or pagination semantics change. */
    persistenceVersion?: number;
    vars?: (scope: TScope) => TVars;
    page?: (data: TResponse) => ConnectionLike;
    /** Relay-connection shorthand: point at the connection object and the query pages it with DENSE nodes (`fromNodes` null-filtering applied). Mutually exclusive with `page`/`select`. */
    connection?: (data: TResponse) => ConnectionLike | null | undefined;
    select?: (data: TResponse) => unknown;
    into: QueryDestination<TStored, TScope>;
    coverage?: ScopeCoverage;
    write?: (context: {
        data: TResponse;
        nodes: unknown[];
        scope: TScope;
    }, plan: WritePlan) => void;
    enabled?: (scope: TScope) => boolean;
    /** Scope keys that must be non-nullish for the query to run; a nullish key holds the query inactive (same as `scope: null`). Replaces hand-written `enabled: s => s.x != null` guards and composes with `enabled`. */
    requiredScope?: ReadonlyArray<keyof TScope & string>;
    /** Freshness window in ms, or the name of a class declared in `configureDb` `defaults.freshnessClasses`. */
    staleTime?: number | string;
    resumeStaleTime?: number | null;
    emptyStaleTime?: number | string;
    refetchOnMount?: boolean;
    maxPages?: number;
    direction?: 'forward' | 'backward';
    cursorVar?: string;
    getCursor?: (page: ConnectionLike) => string | null;
    mapCursor?: (cursor: string) => unknown;
};
/** One landed page summary: cursor for the next page and availability. */
export type PageMeta = {
    endCursor: string | null;
    hasNextPage: boolean;
};
/** Derived per-key request state exposed to loading-state computation. */
export type RequestState = {
    isFetching: boolean;
    isFetchingNextPage: boolean;
    isFetched: boolean;
    isPaused: boolean;
    retryAttempt: number;
    error: Error | null;
    hasNextPage: boolean;
    ids: string[];
    resultKind: 'one' | 'many';
    /** When the current chain meta landed; the freshness record follows it whichever path fetched. */
    dataUpdatedAt: number;
};
/** The value stored per query key in the package QueryClient: fetch chain meta only - rows live in the store. */
export type ChainMeta = {
    cursor: string | null;
    pages: number;
    hasNextPage: boolean;
    ids: string[];
    resultKind: 'one' | 'many';
};
export type QueryResult<T, TData = T[] | T | undefined> = {
    data: TData;
    loadingState: LoadingState;
    error: Error | null;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => void;
    refresh: () => Promise<void>;
};
export type EnsuredRowResult<TStored> = {
    data: TStored | undefined;
    loadingState: LoadingState;
    error: Error | null;
    refresh: () => Promise<void>;
};
export type QueryHandle<TStored, TScope, TData = TStored[] | TStored | undefined> = {
    read(scope: TScope | null): TData;
    use(scope: TScope | null, options?: {
        enabled?: boolean;
    }): QueryResult<TStored, TData>;
    fetch(scope: TScope | null): Promise<void>;
    refresh(scope: TScope | null): Promise<void>;
    invalidate(scope?: TScope): void;
};
/** Options for a scope query's bridged window read. */
export type ScopeQueryWindowOptions<TStored> = {
    pageSize?: number;
    renderKeys?: readonly (keyof TStored & string)[];
    require?: readonly (keyof TStored & string)[];
    keepPrevious?: boolean;
    enabled?: boolean;
    /** Trailing debounce for `loadMore` bursts (default 160ms). */
    loadMoreDebounceMs?: number;
};
/** Scope-destination query handle: array reads plus the bridged local-window/network-pagination surface. */
export type ScopeQueryHandle<TStored, TScope> = QueryHandle<TStored, TScope, TStored[]> & {
    /** One list-ready surface: the scope's local window bridged with this query's network pagination (`bridgeWindowPagination` semantics - reveal synced rows first, then fetch the next server page). `loadMore` is the debounced list-footer advance: bursts collapse into one trailing call, guarded at fire time by `hasNextPage`/`isFetchingNextPage`. */
    useWindow(scope: TScope | null, options?: ScopeQueryWindowOptions<TStored>): WindowPaginationBridge<TStored> & {
        loadMore: () => void;
    };
};
export type EnsuredRowQueryHandle<TStored, TScope, TData = TStored[] | TStored | undefined> = QueryHandle<TStored, TScope, TData> & {
    useRowEnsured(scope: TScope, rowId: string | null | undefined, readOpts?: {
        renderKeys?: readonly (keyof TStored & string)[];
        require?: readonly (keyof TStored & string)[];
    }): EnsuredRowResult<TStored>;
};
//# sourceMappingURL=dsl.query.types.d.ts.map