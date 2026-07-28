import type { DbGraphQLDocument, DbReadOptions, EnsuredRowQueryHandle, ExtractSink, QueryHandle, ScopeCoverage, ScopeHandle } from '../types';
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
/**
 * Create one extract sink only when a row exists; pair with the `{ into, rows }` extract contract.
 *
 * @param into Extract destination.
 * @param row Optional source row.
 * @returns One extract sink, or an empty list.
 */
export declare const intoIf: (into: ExtractSink["into"], row: unknown) => ExtractSink[];
type ScopeDestination<TStored, TScope> = ScopeHandle<TStored & {
    id: string;
}, TScope>;
type ModelDestination<TStored> = {
    modelId: string;
    get?: (id: string | null | undefined) => TStored | undefined;
    use: {
        find(id: string | null | undefined, opts?: DbReadOptions<TStored> & {
            renderKeys?: readonly (keyof TStored & string)[];
        }): TStored | undefined;
    };
};
type QueryDestination<TStored, TScope> = ScopeDestination<TStored, TScope> | ModelDestination<TStored>;
type QueryConfig<TResponse, TVars, TScope, TStored> = {
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
/** Define a coordinator-owned GraphQL query: react-query drives freshness/single-flight/retry, results land through the store's write seams. */
export declare const defineQuery: <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>) => QueryHandle<TStored, TScope> | EnsuredRowQueryHandle<TStored, TScope>;
export {};
//# sourceMappingURL=defineQuery.d.ts.map