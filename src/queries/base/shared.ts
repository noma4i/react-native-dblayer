import { eq, isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { isEqual, pick } from 'es-toolkit';
import type { BaseQueryCollection, CollectionFetchState, CollectionModel, CollectionReadConfig, StableProjectionConfig, SyncContract } from '../../types';
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

const EMPTY: readonly unknown[] = [];

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

/** Create an infinite-query collection binding around a model. */
export const createCollectionBinding = <TStored extends { id: string }>(model: CollectionModel<unknown, TStored>, readConfig?: CollectionReadConfig<TStored>) => ({
  _dbModel: model,
  _dbScope: (filter?: unknown) => toStoredScopeFilter<TStored>(filter, readConfig?.scopeMap),

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

  useData: (filter?: unknown, inactive = false): TStored[] => {
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
    return (data ?? EMPTY) as TStored[];
  },

  shouldSkipInitialFetch: (filter?: unknown, maxAgeMs?: number) => {
    const scopedFilter = toStoredScopeFilter<TStored>(filter, readConfig?.scopeMap);
    return model.shouldSkipInitialFetch(scopedFilter, maxAgeMs);
  },

  getFetchState: (filter?: unknown) => {
    const scopedFilter = toStoredScopeFilter<TStored>(filter, readConfig?.scopeMap);
    return model.getFetchState(scopedFilter);
  },

  markFetched: (filter?: unknown, state?: Omit<CollectionFetchState, 'touchedAt'>) => {
    const scopedFilter = toStoredScopeFilter<TStored>(filter, readConfig?.scopeMap);
    model.markFetched(scopedFilter, state);
  }
});

/** Combine a scope filter with the current user id. */
export const buildModelFilter = (filter: unknown, currentUserId: string | undefined): unknown => {
  if (!filter && !currentUserId) return undefined;
  if (!filter) return { currentUserId };
  if (typeof filter === 'object') return { ...(filter as Record<string, unknown>), currentUserId };
  return filter;
};

/** Build stable projected items by reusing unchanged cached entries. */
export const buildStableItems = <TSource, TEntry extends { item: TItem }, TItem>(
  sources: TSource[],
  config: StableProjectionConfig<TSource, TEntry, TItem>,
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

/** React hook that reads rows by id and returns them keyed by id. */
export const useEntitiesById = <T extends { id: string }>(model: { byIds: (ids: string[]) => T[] }, ids: string[]): Map<string, T> => useMapById(model.byIds(ids));
