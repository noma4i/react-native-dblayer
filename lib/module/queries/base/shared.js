'use strict';

import { isEqual, omit, pick } from 'es-toolkit';
import { useMemo, useRef } from 'react';
const EMPTY = Object.freeze([]);
/** Build stable projected items by reusing unchanged cached entries. */
export const buildStableItems = (sources, config, previousCache) => {
  if (!sources.length) {
    return {
      items: config.emptyItems,
      cache: new Map()
    };
  }
  const cache = new Map();
  const items = [];
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
  return {
    items,
    cache
  };
};
const sameItems = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * Shared value-equality: reuse a prior view object when its rendered fields are unchanged. `useLiveQuery`
 * emits new object refs for unchanged rows, so identity-only reuse fails broadly and re-renders the whole
 * list/thread/feed; deep-comparing the listed fields keeps the view object's identity stable so memoized
 * rows skip re-rendering. One helper for chat list, chat thread AND feed - add a rendered field to the key
 * array to track it.
 */
export const pickEqual = (prev, next, keys) => {
  if (prev == null || next == null) {
    return prev === next;
  }
  return isEqual(pick(prev, keys), pick(next, keys));
};
const defaultStableGetKey = source => {
  const id = source.id;
  if (typeof id !== 'string') {
    throw new Error('useStableProjection default getKey requires source items with a string id.');
  }
  return id;
};
const defaultStableBuildEntry = source => ({
  item: source
});
const resolveStableItemsConfig = config => {
  if ('entriesEqual' in config && typeof config.entriesEqual === 'function') {
    return {
      getKey: config.getKey ?? defaultStableGetKey,
      buildEntry: config.buildEntry ?? defaultStableBuildEntry,
      emptyItems: config.emptyItems ?? EMPTY,
      entriesEqual: config.entriesEqual
    };
  }
  return {
    getKey: config.getKey ?? defaultStableGetKey,
    buildEntry: config.buildEntry ?? defaultStableBuildEntry,
    emptyItems: config.emptyItems ?? EMPTY,
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
export function useStableProjection(sources, config) {
  const cacheRef = useRef(new Map());
  const itemsRef = useRef(null);
  return useMemo(() => {
    const stableConfig = resolveStableItemsConfig(config);
    const built = buildStableItems(sources, stableConfig, cacheRef.current);
    cacheRef.current = built.cache;
    const nextItems = built.items.length > 0 ? built.items : stableConfig.emptyItems;
    const previousItems = itemsRef.current;
    if (previousItems && sameItems(previousItems, nextItems)) {
      return previousItems;
    }
    itemsRef.current = nextItems;
    return nextItems;
  }, [sources, config]);
}
const stableEntityEqual = (prev, next, config) => {
  if ('renderKeys' in config) {
    return pickEqual(prev, next, config.renderKeys);
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
export function useStableEntity(value, config) {
  const stableRef = useRef(value);
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
export const useStableSorted = (source, compare, invalidationKey) => {
  const sortRef = useRef(null);
  return useMemo(() => {
    const previous = sortRef.current;
    if (previous && Object.is(previous.invalidationKey, invalidationKey) && sameItems(previous.source, source)) {
      return previous.output;
    }
    const output = source.length > 0 ? [...source].sort(compare) : [];
    sortRef.current = {
      source,
      invalidationKey,
      output
    };
    return output;
  }, [source, compare, invalidationKey]);
};
//# sourceMappingURL=shared.js.map
