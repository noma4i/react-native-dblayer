import type { BaseQueryCollection, CollectionFetchState, CollectionModel, CollectionReadConfig, StableProjectionConfig, SyncContract } from '../../types';
/** React hook that reads configured query data from a model. */
export declare function useCollectionRead<TData>(collection: BaseQueryCollection | undefined): TData | undefined;
/** Create an infinite-query collection binding around a model. */
export declare const createCollectionBinding: <TStored extends {
    id: string;
}>(model: CollectionModel<unknown, TStored>, readConfig?: CollectionReadConfig<TStored>) => {
    applyServerData: (items: unknown[], contract: SyncContract) => import("../..").MergeResult | import("../..").ReplaceResult;
    useData: (filter?: unknown, inactive?: boolean) => TStored[];
    shouldSkipInitialFetch: (filter?: unknown, maxAgeMs?: number) => boolean;
    getFetchState: (filter?: unknown) => CollectionFetchState | null;
    markFetched: (filter?: unknown, state?: Omit<CollectionFetchState, "touchedAt">) => void;
};
/** Combine a scope filter with the current user id. */
export declare const buildModelFilter: (filter: unknown, currentUserId: string | undefined) => unknown;
/** Build stable projected items by reusing unchanged cached entries. */
export declare const buildStableItems: <TSource, TEntry extends {
    item: TItem;
}, TItem>(sources: TSource[], config: StableProjectionConfig<TSource, TEntry, TItem>, previousCache: Map<string, TEntry>) => {
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
/** React hook that reads rows by id and returns them keyed by id. */
export declare const useEntitiesById: <T extends {
    id: string;
}>(model: {
    byIds: (ids: string[]) => T[];
}, ids: string[]) => Map<string, T>;
//# sourceMappingURL=shared.d.ts.map