import type { BaseQueryCollection, BaseQueryCollectionData, CollectionFetchState, CollectionModel, CollectionReadConfig, StableItemsConfig, StableEntityConfig, SyncContract } from '../../types';
/**
 * React hook that reads configured query data from a model.
 *
 * KNOWN RULES-OF-HOOKS HAZARD (not fixed - see constraint below): if the same call site's `collection`
 * argument toggles between `undefined` and a defined value across renders, or between the
 * `BaseQueryCollectionFind` and `BaseQueryCollectionAll` variants, this function calls a different
 * number/identity of hooks per render. `collection.model.find(id)` itself is already hook-order-safe for
 * any `id` value including nullish (its internal `useLiveQuery` always runs; only the query builder is
 * gated) - the unsafe part is this function's own early `return undefined` when `collection` is absent,
 * and its choice between calling `.find` vs `.all` when it IS present.
 *
 * This could not be unified without one of: (a) requiring `collection` to always be defined so there is
 * always a model reference to call a hook against - genuinely absent at call sites that gate the whole
 * read on a not-yet-available id, and a change to the public `BaseQueryCollection | undefined` contract
 * this function is exported with; or (b) always calling both `.find` and `.all` on every render to keep
 * hook count constant, which would run a permanent full-collection `all()` subscription behind every
 * single detail read in the app for a result it never uses - an unacceptable resource-usage regression,
 * not merely a style change. Both fixes cross the "no public behavior change" line for this task, so the
 * only safe path in practice today is what callers already do: keep a call site's `collection` argument
 * on the same code path (defined-or-undefined, find-or-all) for the lifetime of the mounted component
 * that reads it, rather than swapping it dynamically.
 *
 * @param collection Model-backed detail (`find`) or all-rows (`all`) read configuration.
 * @returns The read row/rows, or `undefined` when no collection is configured or nothing matched.
 */
export declare function useCollectionRead<TCollection extends BaseQueryCollection | undefined>(collection: TCollection): BaseQueryCollectionData<TCollection> | undefined;
/** Create an infinite-query collection binding around a model. */
export declare const createCollectionBinding: <TStored extends {
    id: string;
}, TRead = TStored>(model: CollectionModel<unknown, TStored>, readConfig?: CollectionReadConfig<TStored, TRead>) => {
    _dbModel: CollectionModel<unknown, TStored>;
    _dbScope: (filter?: unknown) => Partial<TStored> | undefined;
    applyServerData: (items: unknown[], contract: SyncContract) => import("../..").MergeResult | import("../..").ReplaceResult;
    useData(filter?: unknown): TRead[];
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
type JoinedEntitiesModel<TStored extends {
    id: string;
}> = {
    byIds(ids: string[]): TStored[];
};
type JoinedEntitiesConfig<TJoin, TStored extends {
    id: string;
}, TItem extends object> = {
    idField: keyof TJoin & string;
    model: JoinedEntitiesModel<TStored>;
    renderKeys?: ReadonlyArray<keyof TItem & string>;
    map?: (join: TJoin, entity: TStored) => TItem;
};
/**
 * React hook that hydrates join rows into entity rows while preserving join-row order.
 *
 * Missing entity ids are dropped, matching `useOrderedEntities`. The optional `map` callback must be
 * pure; its result participates in the same `useStableItems` render-key stability contract as manual
 * `useOrderedEntities` plus `useStableItems` pipelines.
 *
 * @param joinRows Join rows whose `idField` stores the entity id. Nullish and empty inputs return the shared stable empty array.
 * @param config Entity id field, model read surface, optional render keys, and optional pure join/entity projection.
 * @returns Stable hydrated entities, or mapped items when `map` is provided.
 */
export declare function useJoinedEntities<TJoin, TStored extends {
    id: string;
}>(joinRows: readonly TJoin[] | null | undefined, config: JoinedEntitiesConfig<TJoin, TStored, TStored> & {
    map?: undefined;
}): TStored[];
export declare function useJoinedEntities<TJoin, TStored extends {
    id: string;
}, TItem extends object>(joinRows: readonly TJoin[] | null | undefined, config: JoinedEntitiesConfig<TJoin, TStored, TItem> & {
    map: (join: TJoin, entity: TStored) => TItem;
}): TItem[];
/** Window a rendered list one page at a time while delegating network pagination and refresh. */
export declare const useWindowedLoadMore: (networkLoadMore: () => void, networkRefresh: () => Promise<void>, pageSize: number, resetKey: unknown) => {
    windowSize: number;
    loadMore: () => void;
    refresh: () => Promise<void>;
};
export {};
//# sourceMappingURL=shared.d.ts.map