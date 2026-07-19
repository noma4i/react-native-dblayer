import type { DbGraphQLDocument, LoadingState } from '../types';
type FetchConfigBase<TData, TInput, TSelected> = {
    /** Stable cache-key namespace for this fetch, combined with a hash of `input`. */
    key: string;
    /** Pick the payload to expose as `data`; the raw response is never returned. */
    select: (data: TData) => TSelected;
    /** Derive GraphQL variables from the hook/imperative call input. Omit for input-less queries. */
    vars?: (input: TInput) => Record<string, unknown>;
    /** Gate `use(input)`'s automatic network fetch; `false` keeps the hook network-idle. Does not affect `fetch(input)`. */
    enabled?: (input: TInput) => boolean;
    /** Freshness window (ms) before a result is considered stale and refetched. Defaults to `DbDefaults.staleTime`, then `0`. */
    staleTime?: number;
    /** Freshness window (ms) used instead of `staleTime` when `isEmpty` classifies the last selected result as empty. Defaults to `DbDefaults.emptyStaleTime`. */
    emptyStaleTime?: number;
    /** Classify a selected result as empty. Defaults to nullish values and empty arrays. */
    isEmpty?: (data: TSelected) => boolean;
    /** TanStack Query cache garbage-collection time (ms). Defaults to `DbDefaults.gcTime`. */
    gcTime?: number;
};
type FetchConfig<TData, TInput, TSelected> = FetchConfigBase<TData, TInput, TSelected> & ({
    /** The GraphQL query document. `TData` flows from a `TypedDocumentNode`. */
    document: DbGraphQLDocument<TData, Record<string, unknown>>;
    fetcher?: never;
} | {
    /** Execute a store-free request without a GraphQL transport operation. */
    fetcher: (input: TInput) => Promise<TData>;
    document?: never;
});
/** Reactive result of `fetchQuery.use(input)`. */
export type FetchResult<TSelected> = {
    /** The selected payload; `undefined` before the first successful fetch. */
    data: TSelected | undefined;
    /** UI loading-state machine derived from fetch status and whether `data` is present. */
    loadingState: LoadingState;
    /** The last fetch error, or `null`. */
    error: unknown;
    /** Re-run the fetch, replacing `data` on success. Does not return a promise - await `fetch(input)` instead. */
    refetch: () => void;
};
/**
 * Define an ephemeral, store-free fetch: runs GraphQL or a custom fetcher, selects a payload, and exposes it through
 * a reactive TanStack Query-backed hook plus an imperative call. Unlike `defineQuery`, there is no `into`
 * destination - the response never reaches the apply pipeline, never writes a journal record, and never
 * touches a `dbl:` storage key. Use it for display-only data with no local reactive read of its own
 * (pricing tables, country lists, SKU catalogs) where a `defineQuery` write destination would be pure
 * overhead.
 *
 * @param config Document, cache key, `select`, and optional variables, enablement, freshness, empty-result, and cache-lifetime policies.
 * @returns `{ use, fetch, remove }`. `use(input)` is a hook returning a `FetchResult`. `fetch(input)` runs
 * through the owned query client. `remove()` drops every cached input for this key.
 */
export declare const defineFetch: <TData, TInput = void, TSelected = TData>(config: FetchConfig<TData, TInput, TSelected>) => {
    use: (input: TInput) => FetchResult<TSelected>;
    fetch: (input: TInput) => Promise<TSelected>;
    remove: () => void;
};
export {};
//# sourceMappingURL=defineFetch.d.ts.map