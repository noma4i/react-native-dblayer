import type { DbGraphQLDocument, LoadingState } from '../types';
import type { JournalOp } from '../core/apply/journal';
import type { ScopeHandle } from './defineModel';
import type { Coverage } from './scope';
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
export type QueryResult<T> = {
    data: T[] | T | undefined;
    loadingState: LoadingState;
    error: Error | null;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    loadMore: () => void;
    refetch: () => Promise<void>;
};
type PlanRowsSink = {
    modelId: string;
    __planRows?: (rows: unknown[]) => JournalOp[];
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
    __planRows?: (rows: TStored[]) => JournalOp[];
    get?: (id: string | null | undefined) => TStored | undefined;
};
type QueryDestination<TStored, TScope> = ScopeDestination<TStored, TScope> | ModelDestination<TStored>;
type QueryConfig<TResponse, TVars, TScope, TStored> = {
    document: DbGraphQLDocument<TResponse, TVars>;
    /** Stable cache-key namespace; defaults to the document's operation name. */
    key?: string;
    vars?: (scope: TScope) => TVars;
    /** Infinite connection selector - XOR with `select`. */
    page?: (data: TResponse) => ConnectionLike;
    select?: (data: TResponse) => unknown;
    into: QueryDestination<TStored, TScope>;
    coverage?: Coverage;
    /** Edge payload for scope entries; receives the connection edge object (or the node for plain lists). */
    edge?: (edgeSource: unknown) => Record<string, unknown> | undefined;
    /** Cross-model sideloads applied in the SAME transaction as the main rows. */
    extract?: (ctx: {
        data: TResponse;
        nodes: unknown[];
    }) => ExtractSink[];
    map?: (selected: unknown) => unknown;
    enabled?: (scope: TScope) => boolean;
    staleTime?: number;
    emptyStaleTime?: number;
    gcTime?: number;
    maxPages?: number;
    refetchOnMount?: boolean;
    direction?: 'forward' | 'backward';
    /** GraphQL variable carrying the page cursor; defaults to 'after' ('before' when backward). */
    cursorVar?: string;
    getCursor?: (page: ConnectionLike) => string | null;
};
/** Define a query that compiles GraphQL responses into one apply-pipeline transaction. */
export declare const defineQuery: <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>) => {
    use: (scope: TScope) => QueryResult<TStored>;
    fetch: (scope: TScope) => Promise<void>;
    invalidate: (scope?: TScope) => void;
};
export {};
//# sourceMappingURL=defineQuery.d.ts.map