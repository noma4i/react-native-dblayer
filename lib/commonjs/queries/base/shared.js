"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.pickEqual = exports.createCollectionBinding = exports.buildStableItems = exports.buildModelFilter = void 0;
exports.useCollectionRead = useCollectionRead;
exports.useEntitiesById = void 0;
var _db = require("@tanstack/db");
var _reactDb = require("@tanstack/react-db");
var _esToolkit = require("es-toolkit");
var _mapById = require("./mapById.js");
/** React hook that reads configured query data from a model. */
function useCollectionRead(collection) {
  if (!collection) return undefined;
  if ('id' in collection) {
    return collection.model.find(collection.id);
  }
  const items = collection.model.all();
  return items.length > 0 ? items : undefined;
}
const EMPTY = [];
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

/** Create an infinite-query collection binding around a model. */
const createCollectionBinding = (model, readConfig) => ({
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
  useData: (filter, inactive = false) => {
    const col = model._collection;
    const sortField = readConfig?.sortField;
    const sortDir = readConfig?.sortDirection ?? 'desc';
    const scopeEntries = buildScopeEntries(filter, readConfig?.scopeMap);
    const {
      data
    } = (0, _reactDb.useLiveQuery)(q => {
      if (inactive) return undefined;
      let query = q.from({
        items: col
      });
      for (const [field, value] of scopeEntries) {
        if (value === null) {
          query = query.where(({
            items
          }) => (0, _db.isNull)(items[field]));
        } else {
          query = query.where(({
            items
          }) => (0, _db.eq)(items[field], value));
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
    return data ?? EMPTY;
  },
  shouldSkipInitialFetch: (filter, maxAgeMs) => {
    const scopedFilter = toStoredScopeFilter(filter, readConfig?.scopeMap);
    return model.shouldSkipInitialFetch(scopedFilter, maxAgeMs);
  },
  getFetchState: filter => {
    const scopedFilter = toStoredScopeFilter(filter, readConfig?.scopeMap);
    return model.getFetchState(scopedFilter);
  },
  markFetched: (filter, state) => {
    const scopedFilter = toStoredScopeFilter(filter, readConfig?.scopeMap);
    model.markFetched(scopedFilter, state);
  }
});

/** Combine a scope filter with the current user id. */
exports.createCollectionBinding = createCollectionBinding;
const buildModelFilter = (filter, currentUserId) => {
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

/** Build stable projected items by reusing unchanged cached entries. */
exports.buildModelFilter = buildModelFilter;
const buildStableItems = (sources, config, previousCache) => {
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

/**
 * Shared value-equality: reuse a prior view object when its rendered fields are unchanged. `useLiveQuery`
 * emits new object refs for unchanged rows, so identity-only reuse fails broadly and re-renders the whole
 * list/thread/feed; deep-comparing the listed fields keeps the view object's identity stable so memoized
 * rows skip re-rendering. One helper for chat list, chat thread AND feed - add a rendered field to the key
 * array to track it.
 */
exports.buildStableItems = buildStableItems;
const pickEqual = (prev, next, keys) => {
  if (prev == null || next == null) {
    return prev === next;
  }
  return (0, _esToolkit.isEqual)((0, _esToolkit.pick)(prev, keys), (0, _esToolkit.pick)(next, keys));
};

/** React hook that reads rows by id and returns them keyed by id. */
exports.pickEqual = pickEqual;
const useEntitiesById = (model, ids) => (0, _mapById.useMapById)(model.byIds(ids));
exports.useEntitiesById = useEntitiesById;
//# sourceMappingURL=shared.js.map