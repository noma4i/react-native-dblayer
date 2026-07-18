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
 *
 * @param prev Previous value in the comparison.
 * @param next Next value in the comparison.
 * @param keys Keys to compare between values.
 * @returns `true` when the selected fields of `prev` and `next` are deeply equal.
 */
export declare const pickEqual: <T extends object>(prev: T | null | undefined, next: T | null | undefined, keys: Array<keyof T>) => boolean;
/**
 * React hook that projects a stable item list: it owns an entry cache keyed by `getKey`, reuses cached
 * entries whose `entriesEqual` still holds, and returns the previous array reference when every item is
 * unchanged.
 *
 * @param sources Source rows to project, in order.
 * @param config Projection config: `getKey` (defaults to `source.id`), `buildEntry` (defaults to
 * `{ item: source }`), `emptyItems`, and either `entriesEqual` or `renderKeys` for entry equality.
 * @returns The projected item array; the same array reference when nothing changed, a new array otherwise.
 */
export declare function useStableProjection<TSource, TEntry extends {
    item: TItem;
}, TItem extends object>(sources: TSource[], config: StableItemsConfig<TSource, TEntry, TItem>): TItem[];
/**
 * React hook that reuses one entity reference while configured fields remain equal, so consumers memoized
 * on identity skip re-rendering for changes to fields they do not display.
 *
 * @param value Current entity value; `null`/`undefined` pass through unchanged (adopting the new nullish
 * value immediately resets the stored reference, so returning to a non-nullish value always adopts it).
 * @param config Either `renderKeys` (compare only these fields) or `volatileKeys` (compare all fields
 * except these).
 * @returns `value` on the first call or after a real change; otherwise the previous stable reference.
 */
export declare function useStableEntity<TItem extends object>(value: TItem | null | undefined, config: StableEntityConfig<TItem>): TItem | null | undefined;
/**
 * React hook that memoizes sorted output and reuses it for element-identical input arrays, so a component
 * memoized on the sorted array's identity skips re-rendering when nothing actually moved.
 *
 * @param source Rows to sort; not mutated.
 * @param compare Standard `Array.prototype.sort` comparator.
 * @param invalidationKey Extra dependency that forces a resort even when `source`'s elements are unchanged
 * (e.g. a sort-direction flag `compare` closes over).
 * @returns The sorted array; the same array reference when `source` (by element identity) and
 * `invalidationKey` are both unchanged since the last call, a new sorted array otherwise.
 */
export declare const useStableSorted: <T>(source: T[], compare: (left: T, right: T) => number, invalidationKey?: unknown) => T[];
export {};
//# sourceMappingURL=shared.d.ts.map