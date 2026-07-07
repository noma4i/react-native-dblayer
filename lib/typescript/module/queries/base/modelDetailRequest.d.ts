import type { CollectionModel, DbGraphQLDocument, DbRequestSingleConfig } from '../../types';
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
    /** Gate query execution. Combined with `Boolean(id)`. */
    enabled?: DetailEnabled;
    /** Mark the owning screen inactive for loading-state purposes. */
    inactive?: boolean;
    /** React Query freshness window in milliseconds. */
    staleTime?: number;
    /** React Query cache garbage-collection window in milliseconds. */
    gcTime?: number;
    /** React Query remount refetch behavior. */
    refetchOnMount?: boolean;
};
/**
 * Build a model-backed detail request config with derived key, vars, sync, read, and enabled fields.
 */
export declare const modelDetailRequest: <TResponse, TStored extends {
    id: string;
    updatedAt?: string | null;
}, TSelected = TStored, TResult = TSelected, TVariables = Record<string, unknown>>(model: CollectionModel<any, TStored>, config: ModelDetailRequestConfig<TResponse, TSelected, TResult, TVariables>) => DbRequestSingleConfig<TResponse, TResult, TSelected, TVariables>;
export {};
//# sourceMappingURL=modelDetailRequest.d.ts.map