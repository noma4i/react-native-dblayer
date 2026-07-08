import type { BaseQueryCollection, CollectionFetchState, CollectionModel, CollectionReadConfig, StableItemsConfig, StableEntityConfig, SyncContract } from '../../types';
/** React hook that reads configured query data from a model. */
export declare function useCollectionRead<TData>(collection: BaseQueryCollection | undefined): TData | undefined;
/** Create an infinite-query collection binding around a model. */
export declare const createCollectionBinding: <TStored extends {
    id: string;
}, TRead = TStored>(model: CollectionModel<unknown, TStored>, readConfig?: CollectionReadConfig<TStored, TRead>) => {
    _dbModel: CollectionModel<unknown, TStored>;
    _dbScope: (filter?: unknown) => Partial<TStored> | undefined;
    applyServerData: (items: unknown[], contract: SyncContract) => import("../..").MergeResult | import("../..").ReplaceResult;
    useData(filter?: unknown, inactive?: boolean): TRead[];
    count(filter?: unknown | null): number;
    shouldSkipInitialFetch: (filter?: unknown, maxAgeMs?: number, emptyMaxAgeMs?: number) => boolean;
    getFetchState: (filter?: unknown) => CollectionFetchState | null;
    markFetched: (filter?: unknown, state?: Omit<CollectionFetchState, "touchedAt">) => void;
};
/** Combine a scope filter with the current user id. */
export declare const buildModelFilter: (filter: unknown, currentUserId: string | undefined) => unknown;
/** Resolve a request scope value, including lazy scopes. */
export declare const resolveRequestScope: (scope: unknown | (() => unknown) | undefined) => unknown;
/** Use explicit filters ahead of derived scopes. */
export declare const resolveRequestFilter: (filter: (() => unknown) | undefined, scope: unknown | (() => unknown) | undefined) => unknown;
/** Merge derived scope variables with explicit variables; explicit variables win on conflicts. */
export declare const mergeScopeVars: <TVariables>(vars: TVariables | undefined, scope: unknown) => TVariables | undefined;
type ResolvedStableProjectionConfig<TSource, TEntry extends {
    item: TItem;
}, TItem> = {
    getKey: (source: TSource) => string;
    buildEntry: (source: TSource) => TEntry | null;
    emptyItems: TItem[];
    entriesEqual: (prev: TEntry, next: TEntry) => boolean;
};
/** Build stable projected items by reusing unchanged cached entries. */
export declare const buildStableItems: <TSource, TEntry extends {
    item: TItem;
}, TItem>(sources: TSource[], config: ResolvedStableProjectionConfig<TSource, TEntry, TItem>, previousCache: Map<string, TEntry>) => {
    items: TItem[];
    cache: Map<string, TEntry>;
};
/**
 * Shared value-equality: reuse a prior view object when its rendered fields are unchanged. `useLiveQuery`
 * emits new object refs for unchanged rows, so identity-only reuse fails broadly and re-renders the whole
 * list/thread/feed; deep-comparing the listed fields keeps the view object's identity stable so memoized
 * rows skip re-rendering. One helper for chat list, chat thread AND feed - add a rendered field to the key
 * array to track it.
 */
export declare const pickEqual: <T extends object>(prev: T | null | undefined, next: T | null | undefined, keys: Array<keyof T>) => boolean;
/** React hook wrapper around `buildStableItems` with cache ownership and array identity reuse. */
export declare function useStableItems<TSource, TEntry extends {
    item: TItem;
}, TItem extends object>(sources: TSource[], config: StableItemsConfig<TSource, TEntry, TItem>): TItem[];
/** React hook that reuses one entity reference while configured fields remain equal. */
export declare function useStableEntity<TItem extends object>(value: TItem | null | undefined, config: StableEntityConfig<TItem>): TItem | null | undefined;
/** React hook that reuses an array instance when its element references did not change. */
export declare const useStableArray: <TItems extends readonly unknown[]>(next: TItems) => TItems;
/** React hook that memoizes sorted output and reuses it for element-identical input arrays. */
export declare const useStableSorted: <T>(source: T[], compare: (left: T, right: T) => number, invalidationKey?: unknown) => T[];
/** React hook that reads rows by id and returns them keyed by id. */
export declare const useEntitiesById: <T extends {
    id: string;
}>(model: {
    byIds: (ids: string[]) => T[];
}, ids: string[]) => Map<string, T>;
/** React hook that reads entities by id and returns rows in the input id order, dropping missing ids. */
export declare const useOrderedEntities: <T extends {
    id: string;
}>(model: {
    byIds: (ids: string[]) => T[];
}, ids: string[]) => T[];
/** Window a rendered list one page at a time while delegating network pagination and refresh. */
export declare const useWindowedLoadMore: (networkLoadMore: () => void, networkRefresh: () => Promise<void>, pageSize: number, resetKey: unknown) => {
    windowSize: number;
    loadMore: () => void;
    refresh: () => Promise<void>;
};
export {};
//# sourceMappingURL=shared.d.ts.map