import type { BaseQueryCollection, CollectionModel, DbGraphQLDocument, DbRequestSingleConfig } from '../../types';
type DetailId = string | null | undefined;
type DetailIdInput = DetailId | (() => DetailId);
type DetailEnabled = boolean | ((id: DetailId) => boolean);
type DetailVars<TVariables> = TVariables | ((id: DetailId) => TVariables);
export type ModelDetailRequestConfig<TResponse, TSelected, TResult = TSelected, TVariables = Record<string, unknown>> = {
    /** GraphQL query document. */
    query: DbGraphQLDocument<TResponse, TVariables>;
    /** Detail identifier used for derived key, default vars, and default read. */
    id: DetailIdInput;
    /** Pick the payload from response data. */
    select: (data: TResponse) => TSelected;
    /** Explicit key override. Omit to derive `deriveDbKey(model, { id })`. */
    key?: readonly unknown[];
    /** Query variables or a resolver from the detail id. Defaults to `{ id }`. */
    vars?: DetailVars<TVariables>;
    /** Source label for the default model sync. */
    contract?: string;
    /** Transform the selected payload before returning it when no `read` is configured. */
    map?: (selected: TSelected) => TResult;
    /** Side-load payload passed to the extract sink with source `query`. */
    extract?: (params: {
        data: TResponse;
        selected: TSelected;
    }) => unknown;
    /**
     * Whether to read the row back from the model.
     * @default true
     */
    read?: boolean;
    /**
     * Gate query execution, combined with `Boolean(id)`. `false` (or a missing `id`) marks the query
     * fully inactive: the network request is disabled, the freshness gate is skipped, the collection
     * read is suppressed, `data` is `undefined`, `hasFetchedData` is `false`, and the derived loading
     * phase is `'idle'` (not `'initial_loading'`), so `showSkeleton` stays `false` while disabled.
     */
    enabled?: DetailEnabled;
    /** React Query freshness window in milliseconds. */
    staleTime?: number;
    /** Freshness window for known-empty DB scopes in milliseconds. */
    emptyStaleTime?: number;
    /** React Query cache garbage-collection window in milliseconds. */
    gcTime?: number;
    /** React Query remount refetch behavior. */
    refetchOnMount?: boolean;
};
/**
 * Build a model-backed detail request config with derived key, vars, sync, read, and enabled fields.
 * @param model Collection model that stores and reads the detail row.
 * @param config Detail query, selection, sync, read, and React Query options.
 * @returns A single-request config whose default result type is the model stored row for reactive reads.
 */
export declare const modelDetailRequest: <TResponse, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TSelected = TStored, TResult = TStored | null, TVariables = Record<string, unknown>>(model: CollectionModel<any, TStored>, config: ModelDetailRequestConfig<TResponse, TSelected, TResult, TVariables>) => DbRequestSingleConfig<TResponse, TResult, TSelected, TVariables, Extract<BaseQueryCollection<TStored>, {
    id: DetailId;
}>>;
export {};
//# sourceMappingURL=modelDetailRequest.d.ts.map