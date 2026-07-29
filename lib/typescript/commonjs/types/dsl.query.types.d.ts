import type { DbGraphQLDocument, LoadingState } from './db.types';
import type { ScopeCoverage } from './core.planes.scopeIndex.types';
import type { ScopeHandle } from './dsl.model.types';
/** GraphQL pageInfo subset the query DSL understands, in both pagination directions. */
export type PageInfoLike = {
    hasNextPage?: boolean;
    endCursor?: string | null;
    hasPreviousPage?: boolean;
    startCursor?: string | null;
};
/** A relay-style connection or plain node list, as tolerated by the query `page`/`select` seams. */
export type ConnectionLike = {
    nodes?: unknown[];
    edges?: Array<{
        node?: unknown;
    } & Record<string, unknown>>;
    pageInfo?: PageInfoLike;
};
/** Scope landing destination for query results. */
export type ScopeDestination<TStored, TScope> = ScopeHandle<TStored & {
    id: string;
}, TScope>;
/** Model landing destination for query results (row reads only, no scope membership). */
export type ModelDestination<TStored> = {
    modelId: string;
    get?: (id: string | null | undefined) => TStored | undefined;
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
    vars?: (scope: TScope) => TVars;
    page?: (data: TResponse) => ConnectionLike;
    select?: (data: TResponse) => unknown;
    into: QueryDestination<TStored, TScope>;
    coverage?: ScopeCoverage;
    edge?: (edgeSource: unknown) => Record<string, unknown> | undefined;
    extract?: (ctx: {
        data: TResponse;
        nodes: unknown[];
    }) => ExtractSink[];
    map?: (selected: unknown) => unknown;
    enabled?: (scope: TScope) => boolean;
    staleTime?: number;
    resumeStaleTime?: number | null;
    emptyStaleTime?: number;
    refetchOnMount?: boolean;
    maxPages?: number;
    direction?: 'forward' | 'backward';
    cursorVar?: string;
    getCursor?: (page: ConnectionLike) => string | null;
    mapCursor?: (cursor: string) => unknown;
};
/** One landed page summary: cursor for the next page, availability, and landed row count. */
export type PageMeta = {
    endCursor: string | null;
    hasNextPage: boolean;
    count: number;
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
};
/** The value stored per query key in the package QueryClient: fetch chain meta only - rows live in the store. */
export type ChainMeta = {
    lastCount: number;
    cursor: string | null;
    pages: number;
    hasNextPage: boolean;
    ids: string[];
    resultKind: 'one' | 'many';
};
export type PlanRowsSink = {
    modelId: string;
};
export type ExtractSink = {
    into: PlanRowsSink;
    rows: unknown[];
};
export type QueryResult<T> = {
    data: T[] | T | undefined;
    loadingState: LoadingState;
    error: Error | null;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => void;
    refetch: () => Promise<void>;
};
export type EnsuredRowResult<TStored> = {
    data: TStored | undefined;
    loadingState: LoadingState;
    error: Error | null;
    refetch: () => Promise<void>;
};
export type QueryHandle<TStored, TScope> = {
    use(scope: TScope | null, options?: {
        enabled?: boolean;
    }): QueryResult<TStored>;
    fetch(scope: TScope | null): Promise<void>;
    invalidate(scope?: TScope): void;
};
export type EnsuredRowQueryHandle<TStored, TScope> = QueryHandle<TStored, TScope> & {
    useRowEnsured(scope: TScope, rowId: string | null | undefined, readOpts?: {
        renderKeys?: readonly (keyof TStored & string)[];
    }): EnsuredRowResult<TStored>;
};
//# sourceMappingURL=dsl.query.types.d.ts.map