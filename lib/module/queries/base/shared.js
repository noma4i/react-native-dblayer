"use strict";

import { eq, isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { isEqual, omit, pick } from 'es-toolkit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMapById } from "./mapById.js";

/** React hook that reads configured query data from a model. */
export function useCollectionRead(collection) {
  if (!collection) return undefined;
  if ('id' in collection) {
    return collection.model.find(collection.id);
  }
  const items = collection.model.all();
  return items.length > 0 ? items : undefined;
}
const EMPTY = Object.freeze([]);
const toStoredScopeFilter = (filter, scopeMap) => {
  const scopeEntries = buildScopeEntries(filter, scopeMap);
  if (scopeEntries.length === 0) return undefined;
  return Object.fromEntries(scopeEntries);
};
const buildScopeEntries = (filter, scopeMap) => {
  if (!scopeMap || !filter || typeof filter !== 'object') return [];
  const entries = [];
  for (const [filterKey, dataField] of Object.entries(scopeMap)) {
    const value = filter[filterKey];
    if (value !== undefined) {
      entries.push([dataField, value]);
    }
  }
  return entries;
};
const buildScopeFilter = (scope, scopeMap) => {
  if (!scope || typeof scope !== 'object') return undefined;
  const entries = Object.entries(scopeMap).map(([filterKey, dataField]) => [dataField, scope[filterKey]]).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return undefined;
  return item => entries.every(([field, value]) => item[field] === value);
};
const hasExplicitNullishFilter = (argsLength, filter) => argsLength > 0 && filter == null;

/** Create an infinite-query collection binding around a model. */
export const createCollectionBinding = (model, readConfig) => {
  if (readConfig?.sortField && readConfig.comparator) {
    throw new Error('createCollectionBinding received both `sortField` and `comparator`. Use one ordering strategy.');
  }
  const readRows = (filter, inactive) => {
    const col = model._collection;
    const sortField = readConfig?.sortField;
    const sortDir = readConfig?.sortDirection ?? 'desc';
    const scopeEntries = buildScopeEntries(filter, readConfig?.scopeMap);
    const {
      data
    } = useLiveQuery(q => {
      if (inactive) return undefined;
      let query = q.from({
        items: col
      });
      for (const [field, value] of scopeEntries) {
        if (value === null) {
          query = query.where(({
            items
          }) => isNull(items[field]));
        } else {
          query = query.where(({
            items
          }) => eq(items[field], value));
        }
      }
      if (sortField) {
        query = query.orderBy(({
          items
        }) => items[sortField], sortDir);
      }
      return query;
    }, [inactive, ...scopeEntries.map(([, v]) => v)]);
    if (inactive) return EMPTY;
    const rows = data ?? EMPTY;
    return readConfig?.comparator && rows.length > 1 ? [...rows].sort(readConfig.comparator) : rows;
  };
  const readScope = filter => toStoredScopeFilter(filter, readConfig?.scopeMap);
  const isDisabledScopedRead = (argsLength, filter, inactive) => inactive || Boolean(readConfig?.scopeMap && hasExplicitNullishFilter(argsLength, filter));
  return {
    _dbModel: model,
    _dbScope: filter => readScope(filter),
    applyServerData: (items, contract) => {
      if (contract.scope && readConfig?.scopeMap) {
        const scopeFilter = buildScopeFilter(contract.scope, readConfig.scopeMap);
        const freshnessFilter = toStoredScopeFilter(contract.scope, readConfig.scopeMap);
        const nextScopeFilter = contract.mode === 'replace' ? scopeFilter && contract._scopeFilter ? item => scopeFilter(item) && contract._scopeFilter(item) : scopeFilter ?? contract._scopeFilter : contract._scopeFilter;
        return model.applyServerData(items, {
          ...contract,
          _scopeFilter: nextScopeFilter,
          ...(freshnessFilter ? {
            _freshnessFilter: freshnessFilter
          } : {})
        });
      }
      return model.applyServerData(items, contract);
    },
    useData(filter, inactive = false) {
      const disabled = isDisabledScopedRead(arguments.length, filter, inactive);
      const rows = readRows(filter, disabled);
      const overrideRows = readConfig?.useData ? readConfig.useData({
        filter,
        scope: readScope(filter),
        rows,
        inactive: disabled || inactive,
        empty: EMPTY
      }) : undefined;
      if (disabled) return EMPTY;
      if (overrideRows) return overrideRows;
      return rows;
    },
    count(filter) {
      if (hasExplicitNullishFilter(arguments.length, filter)) return 0;
      const scopedFilter = readScope(filter);
      return scopedFilter ? model.count(scopedFilter) : model.count();
    },
    shouldSkipInitialFetch: (filter, maxAgeMs, emptyMaxAgeMs) => {
      const scopedFilter = readScope(filter);
      return model.shouldSkipInitialFetch(scopedFilter, maxAgeMs, emptyMaxAgeMs);
    },
    getFetchState: filter => {
      const scopedFilter = readScope(filter);
      return model.getFetchState(scopedFilter);
    },
    markFetched: (filter, state) => {
      const scopedFilter = readScope(filter);
      model.markFetched(scopedFilter, state);
    }
  };
};

/** Combine a scope filter with the current user id. */
export const buildModelFilter = (filter, currentUserId) => {
  if (!filter && !currentUserId) return undefined;
  if (!filter) return {
    currentUserId
  };
  if (typeof filter === 'object') return {
    ...filter,
    currentUserId
  };
  return filter;
};
const isPlainScopeRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resolve a request scope value, including lazy scopes. */
export const resolveRequestScope = scope => typeof scope === 'function' ? scope() : scope;

/** Use explicit filters ahead of derived scopes. */
export const resolveRequestFilter = (filter, scope) => {
  if (filter) return filter();
  return resolveRequestScope(scope);
};

/** Merge derived scope variables with explicit variables; explicit variables win on conflicts. */
export const mergeScopeVars = (vars, scope) => {
  if (!isPlainScopeRecord(scope)) return vars;
  if (vars === undefined) return scope;
  if (!isPlainScopeRecord(vars)) return vars;
  return {
    ...scope,
    ...vars
  };
};
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
    throw new Error('useStableItems default getKey requires source items with a string id.');
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

/** React hook wrapper around `buildStableItems` with cache ownership and array identity reuse. */
export function useStableItems(sources, config) {
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

/** React hook that reuses one entity reference while configured fields remain equal. */
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

/** React hook that reuses an array instance when its element references did not change. */
export const useStableArray = next => {
  const stableRef = useRef(null);
  const previous = stableRef.current;
  if (previous && sameItems(previous, next)) {
    return previous;
  }
  stableRef.current = next;
  return next;
};

/** React hook that memoizes sorted output and reuses it for element-identical input arrays. */
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

/** React hook that reads rows by id and returns them keyed by id. */
export const useEntitiesById = (model, ids) => useMapById(model.byIds(ids));

/** React hook that reads entities by id and returns rows in the input id order, dropping missing ids. */
export const useOrderedEntities = (model, ids) => {
  const byId = useEntitiesById(model, ids);
  return useMemo(() => {
    if (ids.length === 0) return EMPTY;
    const ordered = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item) ordered.push(item);
    }
    return ordered.length > 0 ? ordered : EMPTY;
  }, [byId, ids]);
};

/** Window a rendered list one page at a time while delegating network pagination and refresh. */
export const useWindowedLoadMore = (networkLoadMore, networkRefresh, pageSize, resetKey) => {
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
  return {
    windowSize,
    loadMore,
    refresh
  };
};
//# sourceMappingURL=shared.js.map