import { eq, isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { isEqual, omit, pick } from 'es-toolkit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BaseQueryCollection,
  CollectionFetchState,
  CollectionModel,
  CollectionReadConfig,
  StableItemsConfig,
  StableEntityConfig,
  StableProjectionConfig,
  SyncContract
} from '../../types';
import { useMapById } from './mapById';

/** React hook that reads configured query data from a model. */
export function useCollectionRead<TData>(collection: BaseQueryCollection | undefined): TData | undefined {
  if (!collection) return undefined;
  if ('id' in collection) {
    return collection.model.find(collection.id) as TData | undefined;
  }
  const items = collection.model.all();
  return items.length > 0 ? (items as unknown as TData) : undefined;
}

const EMPTY: readonly unknown[] = Object.freeze([]);

const toStoredScopeFilter = <TStored>(filter: unknown, scopeMap?: Record<string, keyof TStored & string>): Partial<TStored> | undefined => {
  const scopeEntries = buildScopeEntries<TStored>(filter, scopeMap);
  if (scopeEntries.length === 0) return undefined;
  return Object.fromEntries(scopeEntries) as Partial<TStored>;
};

const buildScopeEntries = <TStored>(filter: unknown, scopeMap?: Record<string, keyof TStored & string>): [string, unknown][] => {
  if (!scopeMap || !filter || typeof filter !== 'object') return [];
  const entries: [string, unknown][] = [];
  for (const [filterKey, dataField] of Object.entries(scopeMap)) {
    const value = (filter as Record<string, unknown>)[filterKey];
    if (value !== undefined) {
      entries.push([dataField as string, value]);
    }
  }
  return entries;
};

const buildScopeFilter = <TStored>(scope: unknown, scopeMap: Record<string, keyof TStored & string>): ((item: unknown) => boolean) | undefined => {
  if (!scope || typeof scope !== 'object') return undefined;
  const entries = Object.entries(scopeMap)
    .map(([filterKey, dataField]) => [dataField, (scope as Record<string, unknown>)[filterKey]] as const)
    .filter(([, v]) => v !== undefined);
  if (entries.length === 0) return undefined;
  return (item: unknown) => entries.every(([field, value]) => (item as Record<string, unknown>)[field] === value);
};

const hasExplicitNullishFilter = (argsLength: number, filter: unknown): boolean => argsLength > 0 && filter == null;

/** Create an infinite-query collection binding around a model. */
export const createCollectionBinding = <TStored extends { id: string }, TRead = TStored>(model: CollectionModel<unknown, TStored>, readConfig?: CollectionReadConfig<TStored, TRead>) => {
  if (readConfig?.sortField && readConfig.comparator) {
    throw new Error('createCollectionBinding received both `sortField` and `comparator`. Use one ordering strategy.');
  }

  const readRows = (filter: unknown, inactive: boolean): TStored[] => {
    const col = model._collection;
    const sortField = readConfig?.sortField;
    const sortDir = readConfig?.sortDirection ?? 'desc';
    const scopeEntries = buildScopeEntries<TStored>(filter, readConfig?.scopeMap);

    const { data } = useLiveQuery(
      q => {
        if (inactive) return undefined;
        let query = q.from({ items: col });
        for (const [field, value] of scopeEntries) {
          if (value === null) {
            query = query.where(({ items }) => isNull((items as Record<string, string | null>)[field]));
          } else {
            query = query.where(({ items }) => eq((items as Record<string, string | null>)[field], value as string | null));
          }
        }
        if (sortField) {
          query = query.orderBy(({ items }) => (items as Record<string, string | null>)[sortField], sortDir);
        }
        return query;
      },
      [inactive, ...scopeEntries.map(([, v]) => v)]
    );

    if (inactive) return EMPTY as TStored[];
    const rows = (data ?? EMPTY) as TStored[];
    return readConfig?.comparator && rows.length > 1 ? [...rows].sort(readConfig.comparator) : rows;
  };

  const readScope = (filter: unknown): Partial<TStored> | undefined => toStoredScopeFilter<TStored>(filter, readConfig?.scopeMap);
  const isDisabledScopedRead = (argsLength: number, filter: unknown, inactive: boolean): boolean => inactive || Boolean(readConfig?.scopeMap && hasExplicitNullishFilter(argsLength, filter));

  return {
    _dbModel: model,
    _dbScope: (filter?: unknown) => readScope(filter),

    applyServerData: (items: unknown[], contract: SyncContract) => {
      if (contract.scope && readConfig?.scopeMap) {
        const scopeFilter = buildScopeFilter<TStored>(contract.scope, readConfig.scopeMap);
        const freshnessFilter = toStoredScopeFilter<TStored>(contract.scope, readConfig.scopeMap);
        const nextScopeFilter =
          contract.mode === 'replace'
            ? scopeFilter && contract._scopeFilter
              ? (item: unknown) => scopeFilter(item as TStored) && contract._scopeFilter!(item)
              : (scopeFilter ?? contract._scopeFilter)
            : contract._scopeFilter;
        return model.applyServerData(items, {
          ...contract,
          _scopeFilter: nextScopeFilter,
          ...(freshnessFilter ? { _freshnessFilter: freshnessFilter as Record<string, unknown> } : {})
        });
      }
      return model.applyServerData(items, contract);
    },

    useData(filter?: unknown, inactive = false): TRead[] {
      const disabled = isDisabledScopedRead(arguments.length, filter, inactive);
      const rows = readRows(filter, disabled);
      const overrideRows = readConfig?.useData
        ? readConfig.useData({
          filter,
          scope: readScope(filter),
          rows,
          inactive: disabled || inactive,
          empty: EMPTY as TRead[]
        })
        : undefined;
      if (disabled) return EMPTY as TRead[];
      if (overrideRows) return overrideRows;
      return rows as unknown as TRead[];
    },

    count(filter?: unknown | null): number {
      if (hasExplicitNullishFilter(arguments.length, filter)) return 0;
      const scopedFilter = readScope(filter);
      return scopedFilter ? model.count(scopedFilter as never) : model.count();
    },

    shouldSkipInitialFetch: (filter?: unknown, maxAgeMs?: number) => {
      const scopedFilter = readScope(filter);
      return model.shouldSkipInitialFetch(scopedFilter, maxAgeMs);
    },

    getFetchState: (filter?: unknown) => {
      const scopedFilter = readScope(filter);
      return model.getFetchState(scopedFilter);
    },

    markFetched: (filter?: unknown, state?: Omit<CollectionFetchState, 'touchedAt'>) => {
      const scopedFilter = readScope(filter);
      model.markFetched(scopedFilter, state);
    }
  };
};

/** Combine a scope filter with the current user id. */
export const buildModelFilter = (filter: unknown, currentUserId: string | undefined): unknown => {
  if (!filter && !currentUserId) return undefined;
  if (!filter) return { currentUserId };
  if (typeof filter === 'object') return { ...(filter as Record<string, unknown>), currentUserId };
  return filter;
};

const isPlainScopeRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resolve a request scope value, including lazy scopes. */
export const resolveRequestScope = (scope: unknown | (() => unknown) | undefined): unknown => (typeof scope === 'function' ? (scope as () => unknown)() : scope);

/** Use explicit filters ahead of derived scopes. */
export const resolveRequestFilter = (filter: (() => unknown) | undefined, scope: unknown | (() => unknown) | undefined): unknown => {
  if (filter) return filter();
  return resolveRequestScope(scope);
};

/** Merge derived scope variables with explicit variables; explicit variables win on conflicts. */
export const mergeScopeVars = <TVariables>(vars: TVariables | undefined, scope: unknown): TVariables | undefined => {
  if (!isPlainScopeRecord(scope)) return vars;
  if (vars === undefined) return scope as TVariables;
  if (!isPlainScopeRecord(vars)) return vars;
  return { ...scope, ...vars } as TVariables;
};

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

/** Window a rendered list one page at a time while delegating network pagination and refresh. */
export const useWindowedLoadMore = (
  networkLoadMore: () => void,
  networkRefresh: () => Promise<void>,
  pageSize: number,
  resetKey: unknown
): { windowSize: number; loadMore: () => void; refresh: () => Promise<void> } => {
  const [windowSize, setWindowSize] = useState(pageSize);

  useEffect(() => {
    setWindowSize(pageSize);
  }, [pageSize, resetKey]);

  const loadMore = useCallback(() => {
    setWindowSize(previous => previous + pageSize);
    networkLoadMore();
  }, [networkLoadMore, pageSize]);

  const refresh = useCallback(() => {
    setWindowSize(pageSize);
    return networkRefresh();
  }, [networkRefresh, pageSize]);

  return { windowSize, loadMore, refresh };
};
