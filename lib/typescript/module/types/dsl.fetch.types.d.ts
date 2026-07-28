import type { DbGraphQLDocument, LoadingState } from './db.types';
type FetchConfigBase<TData, TInput, TSelected> = {
    key: string;
    select: (data: TData) => TSelected;
    vars?: (input: TInput) => Record<string, unknown>;
    enabled?: (input: TInput) => boolean;
    staleTime?: number;
    resumeStaleTime?: number | null;
    emptyStaleTime?: number;
    isEmpty?: (data: TSelected) => boolean;
};
export type FetchConfig<TData, TInput, TSelected> = FetchConfigBase<TData, TInput, TSelected> & ({
    document: DbGraphQLDocument<TData, never>;
    fetcher?: never;
} | {
    fetcher: (input: TInput) => Promise<TData>;
    document?: never;
});
/** Reactive result of `defineFetch(...).use(input)`. */
export type FetchResult<TSelected> = {
    data: TSelected | undefined;
    loadingState: LoadingState;
    error: unknown;
    refetch(): void;
};
/** Imperative and reactive handles created by `defineFetch`. */
export type FetchHandle<TInput, TSelected> = {
    use(input: TInput): FetchResult<TSelected>;
    fetch(input: TInput): Promise<TSelected>;
    remove(): void;
};
export {};
//# sourceMappingURL=dsl.fetch.types.d.ts.map