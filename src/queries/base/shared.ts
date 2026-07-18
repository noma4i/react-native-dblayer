import { isEqual, omit, pick } from 'es-toolkit';
import { useMemo, useRef } from 'react';
import type { StableItemsConfig, StableEntityConfig, StableProjectionConfig } from '../../types';
import { arraysShallowEqual } from '../../read/useLiveRead';

const EMPTY: readonly unknown[] = Object.freeze([]);

type ResolvedStableProjectionConfig<TSource, TEntry extends { item: TItem }, TItem> = {
  getKey: (source: TSource) => string;
  buildEntry: (source: TSource) => TEntry | null;
  emptyItems: TItem[];
  entriesEqual: (prev: TEntry, next: TEntry) => boolean;
};

/** Build stable projected items by reusing unchanged cached entries. */
export const buildStableItems = <TSource, TEntry extends { item: TItem }, TItem>(
  sources: TSource[],
  config: ResolvedStableProjectionConfig<TSource, TEntry, TItem>,
  previousCache: Map<string, TEntry>
): { items: TItem[]; cache: Map<string, TEntry> } => {
  if (!sources.length) {
    return { items: config.emptyItems, cache: new Map() };
  }

  const cache = new Map<string, TEntry>();
  const items: TItem[] = [];
  for (const source of sources) {
    const nextEntry = config.buildEntry(source);
    if (!nextEntry) continue;

    const key = config.getKey(source);
    const previousEntry = previousCache.get(key);
    if (previousEntry && config.entriesEqual(previousEntry, nextEntry)) {
      cache.set(key, previousEntry);
      items.push(previousEntry.item);
    } else {
      cache.set(key, nextEntry);
      items.push(nextEntry.item);
    }
  }

  return { items, cache };
};

/**
 * Shared value-equality: reuse a prior view object when its rendered fields are unchanged. `useLiveQuery`
 * emits new object refs for unchanged rows, so identity-only reuse fails broadly and re-renders the whole
 * list/thread/feed; deep-comparing the listed fields keeps the view object's identity stable so memoized
 * rows skip re-rendering. One helper for chat list, chat thread AND feed - add a rendered field to the key
 * array to track it.
 */
export const pickEqual = <T extends object>(prev: T | null | undefined, next: T | null | undefined, keys: Array<keyof T>): boolean => {
  if (prev == null || next == null) {
    return prev === next;
  }
  return isEqual(pick(prev, keys), pick(next, keys));
};

const defaultStableGetKey = <TSource>(source: TSource): string => {
  const id = (source as { id?: unknown }).id;
  if (typeof id !== 'string') {
    throw new Error('useStableProjection default getKey requires source items with a string id.');
  }
  return id;
};

const defaultStableBuildEntry = <TSource, TItem>(source: TSource): { item: TItem } => ({ item: source as unknown as TItem });

const resolveStableItemsConfig = <TSource, TEntry extends { item: TItem }, TItem extends object>(
  config: StableItemsConfig<TSource, TEntry, TItem>
): ResolvedStableProjectionConfig<TSource, TEntry, TItem> => {
  if ('entriesEqual' in config && typeof config.entriesEqual === 'function') {
    return {
      getKey: config.getKey ?? defaultStableGetKey,
      buildEntry: config.buildEntry ?? (defaultStableBuildEntry as (source: TSource) => TEntry),
      emptyItems: config.emptyItems ?? (EMPTY as TItem[]),
      entriesEqual: config.entriesEqual
    };
  }

  return {
    getKey: config.getKey ?? defaultStableGetKey,
    buildEntry: config.buildEntry ?? (defaultStableBuildEntry as (source: TSource) => TEntry),
    emptyItems: config.emptyItems ?? (EMPTY as TItem[]),
    entriesEqual: (prev, next) => pickEqual(prev.item, next.item, config.renderKeys)
  };
};

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
export function useStableProjection<TSource, TEntry extends { item: TItem }, TItem extends object>(
  sources: TSource[],
  config: StableItemsConfig<TSource, TEntry, TItem>
): TItem[] {
  const cacheRef = useRef<Map<string, TEntry>>(new Map());
  const itemsRef = useRef<TItem[] | null>(null);

  return useMemo(() => {
    const stableConfig = resolveStableItemsConfig(config);
    const built = buildStableItems(sources, stableConfig, cacheRef.current);
    cacheRef.current = built.cache;

    const nextItems = built.items.length > 0 ? built.items : stableConfig.emptyItems;
    const previousItems = itemsRef.current;
    if (previousItems && arraysShallowEqual(previousItems, nextItems)) {
      return previousItems;
    }

    itemsRef.current = nextItems;
    return nextItems;
  }, [sources, config]);
}

const stableEntityEqual = <TItem extends object>(prev: TItem, next: TItem, config: StableEntityConfig<TItem>): boolean => {
  if ('renderKeys' in config) {
    return pickEqual(prev, next, config.renderKeys as Array<keyof TItem>);
  }

  return isEqual(omit(prev, config.volatileKeys), omit(next, config.volatileKeys));
};

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
export function useStableEntity<TItem extends object>(value: TItem | null | undefined, config: StableEntityConfig<TItem>): TItem | null | undefined {
  const stableRef = useRef<TItem | null | undefined>(value);
  const previous = stableRef.current;

  if (value == null) {
    stableRef.current = value;
    return value;
  }

  if (previous != null && stableEntityEqual(previous, value, config)) {
    return previous;
  }

  stableRef.current = value;
  return value;
}

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
export const useStableSorted = <T>(source: T[], compare: (left: T, right: T) => number, invalidationKey?: unknown): T[] => {
  const sortRef = useRef<{ source: T[]; invalidationKey: unknown; output: T[] } | null>(null);

  return useMemo(() => {
    const previous = sortRef.current;
    if (previous && Object.is(previous.invalidationKey, invalidationKey) && arraysShallowEqual(previous.source, source)) {
      return previous.output;
    }

    const output = source.length > 0 ? [...source].sort(compare) : [];
    sortRef.current = { source, invalidationKey, output };
    return output;
  }, [source, compare, invalidationKey]);
};
