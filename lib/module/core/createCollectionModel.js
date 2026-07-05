"use strict";

import { createTransaction, count as dbCount, eq, inArray, isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { toQueryValue } from "../utils/typeBoundary.js";
import { createMerge } from "./createMerge.js";
import { createPatchCrud } from "./createPatchCrud.js";
import { createReplace } from "./createReplace.js";
import { clearCollectionFetchState, clearCollectionFetchStates, getCollectionFetchState, registerCollectionFetchStateCache, setCollectionFetchState } from "./freshnessStorage.js";
import { getDbModelDefaults } from "./modelDefaults.js";
import { isInManagedMutationBatch, registerModelRuntimeReset } from "./registry.js";
import { stableSerialize } from "./serialize.js";
const EMPTY = [];
const GROUP_ALL = 1;
const ROOT_FETCH_SCOPE = '__root__';
const normalizeFilter = filter => {
  if (!filter) return undefined;
  const entries = Object.entries(filter).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
};
const buildFetchScope = filter => {
  const normalized = normalizeFilter(filter);
  if (!normalized) return ROOT_FETCH_SCOPE;
  return stableSerialize(normalized);
};
const applyFilterEntries = (query, filterEntries) => {
  let next = query;
  for (const [key, value] of filterEntries) {
    next = value === null ? next.where(({
      items
    }) => isNull(toQueryValue(items[key]))) : next.where(({
      items
    }) => eq(toQueryValue(items[key]), toQueryValue(value)));
  }
  return next;
};
const createFreshnessTracker = (collectionId, staleTime) => {
  const fetchStateCache = new Map();
  if (collectionId) {
    fetchStateCache.set(ROOT_FETCH_SCOPE, getCollectionFetchState(collectionId));
    registerCollectionFetchStateCache(collectionId, scopeKey => {
      fetchStateCache.delete(scopeKey ?? ROOT_FETCH_SCOPE);
    });
  }
  const getFetchState = filter => {
    const scope = buildFetchScope(filter);
    if (fetchStateCache.has(scope)) {
      return fetchStateCache.get(scope) ?? null;
    }
    const nextState = collectionId ? getCollectionFetchState(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope) : null;
    fetchStateCache.set(scope, nextState);
    return nextState;
  };
  const markFetched = (filter, state) => {
    const scope = buildFetchScope(filter);
    const nextState = {
      touchedAt: Date.now(),
      empty: state?.empty === true,
      ...(state?.pageInfo ? {
        pageInfo: state.pageInfo
      } : {})
    };
    fetchStateCache.set(scope, nextState);
    if (collectionId) {
      setCollectionFetchState(collectionId, nextState, scope === ROOT_FETCH_SCOPE ? undefined : scope);
    }
  };
  const touch = () => {
    markFetched(undefined, {
      empty: false
    });
  };
  const clearFetchState = filter => {
    const scope = buildFetchScope(filter);
    fetchStateCache.delete(scope);
    if (collectionId) {
      clearCollectionFetchState(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope);
    }
  };
  const isStale = (filter, maxAgeMs = staleTime) => {
    const fetchState = getFetchState(filter);
    if (!fetchState) return true;
    if (maxAgeMs <= 0) return true;
    return Date.now() - fetchState.touchedAt > maxAgeMs;
  };
  const shouldSkipInitialFetch = (hasItems, filter, maxAgeMs = staleTime) => {
    const fetchState = getFetchState(filter);
    const hasKnownEmpty = fetchState?.empty === true;
    return (hasItems(filter) || hasKnownEmpty) && !isStale(filter, maxAgeMs);
  };
  const clear = () => {
    fetchStateCache.clear();
    if (collectionId) {
      clearCollectionFetchStates(collectionId);
    }
  };
  const reset = () => {
    fetchStateCache.clear();
  };
  return {
    getFetchState,
    markFetched,
    touch,
    clearFetchState,
    isStale,
    shouldSkipInitialFetch,
    clear,
    reset
  };
};

/** Create a collection model from a persistent collection and normalizer. */
export function createCollectionModel(config) {
  const {
    collection: rawCollection,
    normalize,
    staleTime = 0
  } = config;
  const collectionId = typeof rawCollection.id === 'string' && rawCollection.id.length > 0 ? rawCollection.id : null;
  const freshness = createFreshnessTracker(collectionId, staleTime);
  let resetMergeState = () => {};
  const merge = createMerge({
    collection: rawCollection,
    normalize,
    shouldOverwrite: config.merge?.shouldOverwrite,
    dedupeWindowMs: config.merge?.dedupeWindowMs,
    resolveDedupeWindowMs: () => getDbModelDefaults().merge?.dedupeWindowMs,
    registerReset: reset => {
      resetMergeState = reset;
    }
  });
  const replace = createReplace({
    collection: rawCollection,
    normalize,
    shouldOverwrite: config.replace?.shouldOverwrite
  });
  const crud = createPatchCrud({
    collection: rawCollection
  });
  const tanstackCollection = rawCollection._collection;
  const acceptMutations = rawCollection.acceptMutations.bind(rawCollection);
  const withTransaction = fn => {
    if (isInManagedMutationBatch()) {
      fn();
      return;
    }
    const tx = createTransaction({
      mutationFn: ({
        transaction
      }) => {
        acceptMutations(transaction);
        return Promise.resolve();
      }
    });
    tx.mutate(fn);
  };
  const matchesFilter = (item, filterEntries) => filterEntries.every(([key, value]) => item[key] === value);
  const getSnapshotWhere = filter => {
    const normalized = normalizeFilter(filter);
    const filterEntries = normalized ? Object.entries(normalized) : [];
    if (filterEntries.length === 0) {
      return Array.from(rawCollection.values());
    }
    const results = [];
    for (const item of rawCollection.values()) {
      if (matchesFilter(item, filterEntries)) {
        results.push(item);
      }
    }
    return results;
  };
  const getSnapshotFirstWhere = filter => {
    const normalized = normalizeFilter(filter);
    const filterEntries = normalized ? Object.entries(normalized) : [];
    if (filterEntries.length === 0) {
      return rawCollection.values().next().value;
    }
    for (const item of rawCollection.values()) {
      if (matchesFilter(item, filterEntries)) {
        return item;
      }
    }
    return undefined;
  };
  const hasCached = filter => {
    if (filter && Object.keys(normalizeFilter(filter) ?? {}).length > 0) {
      return getSnapshotFirstWhere(filter) !== undefined;
    }
    if ('size' in rawCollection && typeof rawCollection.size === 'number') {
      return rawCollection.size > 0;
    }
    for (const _ of rawCollection.keys()) return true;
    return false;
  };
  const shouldSkipInitialFetch = (filter, maxAgeMs) => freshness.shouldSkipInitialFetch(hasCached, filter, maxAgeMs);
  const clearScope = () => {
    const ids = [];
    for (const id of rawCollection.keys()) ids.push(String(id));
    withTransaction(() => {
      for (const id of ids) {
        rawCollection.delete(id);
      }
    });
    freshness.clear();
  };
  const destroyMany = ids => {
    let deleted = 0;
    withTransaction(() => {
      for (const id of ids) {
        if (!rawCollection.has(id)) continue;
        rawCollection.delete(id);
        deleted += 1;
      }
    });
    return deleted;
  };
  const destroyWhere = filter => {
    const normalized = normalizeFilter(filter);
    if (!normalized) {
      throw new Error(`[${config.name}] destroyWhere requires a non-empty filter. Use clearScope() for full collection clears.`);
    }
    return destroyMany(getSnapshotWhere(normalized).map(item => item.id));
  };
  const applyServerData = (items, contract) => {
    if (contract.mode === 'replace' && contract.scope !== undefined && contract._scopeFilter === undefined) {
      throw new Error(`[${config.name}] scoped replace requires _scopeFilter. Use createCollectionBinding(...).applyServerData() or provide contract._scopeFilter explicitly.`);
    }
    let result = {
      merged: 0
    };
    withTransaction(() => {
      if (contract.mode === 'replace') {
        const scopeFilter = contract._scopeFilter;
        result = replace(items, scopeFilter);
      } else {
        result = merge(items);
      }
    });
    if (contract._freshnessFilter) {
      freshness.markFetched(contract._freshnessFilter, {
        empty: items.length === 0
      });
    } else if (contract.scope === undefined && contract._scopeFilter === undefined) {
      freshness.touch();
    }
    return result;
  };
  const useFind = id => {
    const {
      data
    } = useLiveQuery(q => id ? q.from({
      items: tanstackCollection
    }).where(({
      items
    }) => eq(toQueryValue(items.id), id)).findOne() : undefined, [id]);
    return data;
  };
  const useAll = () => {
    const {
      data
    } = useLiveQuery(q => {
      let query = q.from({
        items: tanstackCollection
      });
      const defaultSort = config.defaultSort;
      if (defaultSort) {
        query = query.orderBy(({
          items
        }) => toQueryValue(items[defaultSort.field]), defaultSort.direction);
      }
      return query;
    });
    return data ?? EMPTY;
  };
  const useWhere = filter => {
    const normalized = normalizeFilter(filter);
    const filterEntries = normalized ? Object.entries(normalized) : [];
    const {
      data
    } = useLiveQuery(q => applyFilterEntries(q.from({
      items: tanstackCollection
    }), filterEntries), filterEntries.map(([, value]) => value));
    return data ?? EMPTY;
  };
  const useByIds = ids => {
    const {
      data
    } = useLiveQuery(q => ids.length > 0 ? q.from({
      items: tanstackCollection
    }).where(({
      items
    }) => inArray(toQueryValue(items.id), ids)) : undefined, [ids]);
    return data ?? EMPTY;
  };
  const useCount = filter => {
    const normalized = normalizeFilter(filter);
    const filterEntries = normalized ? Object.entries(normalized) : [];
    const {
      data
    } = useLiveQuery(q => applyFilterEntries(q.from({
      items: tanstackCollection
    }), filterEntries).groupBy(() => GROUP_ALL).select(({
      items
    }) => ({
      total: dbCount(toQueryValue(items.id))
    })), filterEntries.map(([, value]) => value));
    return data?.[0]?.total ?? 0;
  };
  registerModelRuntimeReset(config.name, () => {
    freshness.reset();
    resetMergeState();
  });
  return {
    get: id => id ? rawCollection.get(id) : undefined,
    getAll: () => Array.from(rawCollection.values()),
    getWhere: filter => getSnapshotWhere(filter),
    getFirstWhere: filter => getSnapshotFirstWhere(filter),
    patch: (id, updates) => crud.patch(id, updates),
    destroy: id => crud.destroy(id),
    destroyMany,
    destroyWhere,
    replaceRaw: (oldId, item) => {
      const normalized = normalize(item);
      if (!normalized) return false;
      withTransaction(() => {
        rawCollection.delete(oldId);
        rawCollection.insert(normalized);
      });
      return true;
    },
    insertStored: item => {
      rawCollection.insert(item);
    },
    applyServerData,
    markFetched: freshness.markFetched,
    getFetchState: freshness.getFetchState,
    clearFetchState: freshness.clearFetchState,
    shouldSkipInitialFetch,
    clearScope,
    find: useFind,
    all: useAll,
    where: useWhere,
    byIds: useByIds,
    count: useCount,
    collection: tanstackCollection,
    _collection: tanstackCollection
  };
}
//# sourceMappingURL=createCollectionModel.js.map