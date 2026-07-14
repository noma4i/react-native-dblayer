import type { DbGraphQLDocument, LoadingState } from '../types';
import type { ScopeHandle } from './defineModel';
import type { Coverage } from './scope';
type ConnectionLike = {
    nodes?: unknown[];
    edges?: Array<{
        node?: unknown;
    }>;
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
type QueryDestination<TStored, TScope> = ScopeHandle<TStored & {
    id: string;
}, TScope> | {
    __applyRows?: (rows: TStored[]) => void;
    get?: (id: string) => TStored | undefined;
};
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
/** Define a query that compiles selected GraphQL data into a model or scope apply operation. */
export declare const defineQuery: <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>) => {
    fetch: (scope: TScope) => Promise<void>;
    invalidate: (_scope?: TScope) => void;
    use: (scope: TScope) => QueryResult<TStored>;
};
export {};
//# sourceMappingURL=defineQuery.d.ts.map