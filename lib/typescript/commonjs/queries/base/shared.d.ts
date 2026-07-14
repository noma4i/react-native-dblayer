import type { StableItemsConfig, StableEntityConfig } from '../../types';
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
export {};
//# sourceMappingURL=shared.d.ts.map