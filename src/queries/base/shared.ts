import { isEqual, omit, pick } from 'es-toolkit';
import { useMemo, useRef } from 'react';
import type { StableItemsConfig, StableEntityConfig, StableProjectionConfig } from '../../types';
import { readId } from '../../utils/normalizeHelpers';
import { useMapById } from './mapById';

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

const sameItems = <T>(left: readonly T[], right: readonly T[]): boolean => left.length === right.length && left.every((item, index) => item === right[index]);

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
    throw new Error('useStableItems default getKey requires source items with a string id.');
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

/** React hook wrapper around `buildStableItems` with cache ownership and array identity reuse. */
export function useStableItems<TSource, TEntry extends { item: TItem }, TItem extends object>(
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
    if (previousItems && sameItems(previousItems, nextItems)) {
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

/** React hook that reuses one entity reference while configured fields remain equal. */
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

/** React hook that reuses an array instance when its element references did not change. */
export const useStableArray = <TItems extends readonly unknown[]>(next: TItems): TItems => {
  const stableRef = useRef<TItems | null>(null);
  const previous = stableRef.current;
  if (previous && sameItems(previous, next)) {
    return previous;
  }

  stableRef.current = next;
  return next;
};

/** React hook that memoizes sorted output and reuses it for element-identical input arrays. */
export const useStableSorted = <T>(source: T[], compare: (left: T, right: T) => number, invalidationKey?: unknown): T[] => {
  const sortRef = useRef<{ source: T[]; invalidationKey: unknown; output: T[] } | null>(null);

  return useMemo(() => {
    const previous = sortRef.current;
    if (previous && Object.is(previous.invalidationKey, invalidationKey) && sameItems(previous.source, source)) {
      return previous.output;
    }

    const output = source.length > 0 ? [...source].sort(compare) : [];
    sortRef.current = { source, invalidationKey, output };
    return output;
  }, [source, compare, invalidationKey]);
};

/** React hook that reads rows by id and returns them keyed by id. */
export const useEntitiesById = <T extends { id: string }>(model: { byIds: (ids: string[]) => T[] }, ids: string[]): Map<string, T> => useMapById(model.byIds(ids));

/** React hook that reads entities by id and returns rows in the input id order, dropping missing ids. */
export const useOrderedEntities = <T extends { id: string }>(model: { byIds: (ids: string[]) => T[] }, ids: string[]): T[] => {
  const byId = useEntitiesById(model, ids);
  return useMemo(() => {
    if (ids.length === 0) return EMPTY as T[];

    const ordered: T[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item) ordered.push(item);
    }

    return ordered.length > 0 ? ordered : (EMPTY as T[]);
  }, [byId, ids]);
};

type JoinedEntitiesModel<TStored extends { id: string }> = {
  byIds(ids: string[]): TStored[];
};

type JoinedEntitiesConfig<TJoin, TStored extends { id: string }, TItem extends object> = {
  idField: keyof TJoin & string;
  model: JoinedEntitiesModel<TStored>;
  renderKeys?: ReadonlyArray<keyof TItem & string>;
  map?: (join: TJoin, entity: TStored) => TItem;
};

type JoinedEntityPair<TJoin> = {
  id: string;
  join: TJoin;
};

type JoinedEntitySource<TJoin, TStored extends { id: string }> = {
  id: string;
  join: TJoin;
  entity: TStored;
};

const readJoinEntityId = <TJoin,>(join: TJoin, idField: keyof TJoin & string): string | undefined => {
  if (!join || typeof join !== 'object') return undefined;
  return readId((join as Record<string, unknown>)[idField]);
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
export function useJoinedEntities<TJoin, TStored extends { id: string }>(
  joinRows: readonly TJoin[] | null | undefined,
  config: JoinedEntitiesConfig<TJoin, TStored, TStored> & { map?: undefined }
): TStored[];
export function useJoinedEntities<TJoin, TStored extends { id: string }, TItem extends object>(
  joinRows: readonly TJoin[] | null | undefined,
  config: JoinedEntitiesConfig<TJoin, TStored, TItem> & { map: (join: TJoin, entity: TStored) => TItem }
): TItem[];
export function useJoinedEntities<TJoin, TStored extends { id: string }, TItem extends object = TStored>(
  joinRows: readonly TJoin[] | null | undefined,
  config: JoinedEntitiesConfig<TJoin, TStored, TItem>
): TItem[] {
  const pairs = useMemo(() => {
    if (!joinRows?.length) return EMPTY as JoinedEntityPair<TJoin>[];

    const nextPairs: JoinedEntityPair<TJoin>[] = [];
    for (const join of joinRows) {
      const id = readJoinEntityId(join, config.idField);
      if (id) {
        nextPairs.push({ id, join });
      }
    }

    return nextPairs.length > 0 ? nextPairs : (EMPTY as JoinedEntityPair<TJoin>[]);
  }, [joinRows, config.idField]);

  const ids = useMemo(() => {
    if (pairs.length === 0) return EMPTY as string[];
    return pairs.map(pair => pair.id);
  }, [pairs]);

  const orderedEntities = useOrderedEntities(config.model, ids);
  const sources = useMemo(() => {
    if (pairs.length === 0 || orderedEntities.length === 0) return EMPTY as JoinedEntitySource<TJoin, TStored>[];

    const entitiesById = new Map<string, TStored[]>();
    for (const entity of orderedEntities) {
      const bucket = entitiesById.get(entity.id);
      if (bucket) {
        bucket.push(entity);
      } else {
        entitiesById.set(entity.id, [entity]);
      }
    }

    const nextSources: JoinedEntitySource<TJoin, TStored>[] = [];
    for (const pair of pairs) {
      const bucket = entitiesById.get(pair.id);
      const entity = bucket?.shift();
      if (entity) {
        nextSources.push({ id: pair.id, join: pair.join, entity });
      }
    }

    return nextSources.length > 0 ? nextSources : (EMPTY as JoinedEntitySource<TJoin, TStored>[]);
  }, [orderedEntities, pairs]);

  const stableConfig = useMemo(() => {
    const baseConfig = {
      getKey: (source: JoinedEntitySource<TJoin, TStored>) => source.id,
      buildEntry: (source: JoinedEntitySource<TJoin, TStored>) => ({
        item: config.map ? config.map(source.join, source.entity) : (source.entity as unknown as TItem)
      }),
      emptyItems: EMPTY as TItem[]
    };

    if (config.renderKeys) {
      return {
        ...baseConfig,
        renderKeys: config.renderKeys as Array<keyof TItem>
      };
    }

    return {
      ...baseConfig,
      entriesEqual: (prev: { item: TItem }, next: { item: TItem }) => Object.is(prev.item, next.item)
    };
  }, [config.map, config.renderKeys]);

  return useStableItems(sources, stableConfig);
}
