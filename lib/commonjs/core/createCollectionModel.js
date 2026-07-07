"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createCollectionModel = createCollectionModel;
var _db = require("@tanstack/db");
var _reactDb = require("@tanstack/react-db");
var _schema = require("../schema/schema.js");
var _typeBoundary = require("../utils/typeBoundary.js");
var _compileDbWhere = require("./compileDbWhere.js");
var _createMerge = require("./createMerge.js");
var _createPatchCrud = require("./createPatchCrud.js");
var _createReplace = require("./createReplace.js");
var _freshnessStorage = require("./freshnessStorage.js");
var _modelDefaults = require("./modelDefaults.js");
var _modelRegistry = require("./modelRegistry.js");
var _registry = require("./registry.js");
var _serialize = require("./serialize.js");
var _sideload = require("./sideload.js");
const EMPTY = [];
const GROUP_ALL = 1;
const ROOT_FETCH_SCOPE = '__root__';
const buildFetchScope = filter => {
  const normalized = (0, _compileDbWhere.normalizeDbCondition)(filter);
  if (!normalized) return ROOT_FETCH_SCOPE;
  return (0, _serialize.stableSerialize)(normalized);
};
const createFreshnessTracker = (collectionId, staleTime) => {
  const fetchStateCache = new Map();
  if (collectionId) {
    fetchStateCache.set(ROOT_FETCH_SCOPE, (0, _freshnessStorage.getCollectionFetchState)(collectionId));
    (0, _freshnessStorage.registerCollectionFetchStateCache)(collectionId, scopeKey => {
      fetchStateCache.delete(scopeKey ?? ROOT_FETCH_SCOPE);
    });
  }
  const getFetchState = filter => {
    const scope = buildFetchScope(filter);
    if (fetchStateCache.has(scope)) {
      return fetchStateCache.get(scope) ?? null;
    }
    const nextState = collectionId ? (0, _freshnessStorage.getCollectionFetchState)(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope) : null;
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
      (0, _freshnessStorage.setCollectionFetchState)(collectionId, nextState, scope === ROOT_FETCH_SCOPE ? undefined : scope);
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
      (0, _freshnessStorage.clearCollectionFetchState)(collectionId, scope === ROOT_FETCH_SCOPE ? undefined : scope);
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
      (0, _freshnessStorage.clearCollectionFetchStates)(collectionId);
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
const hasFieldsConfig = config => 'fields' in config;
const assertValidFieldsConfig = (name, fields) => {
  if (Object.prototype.hasOwnProperty.call(fields, 'id')) {
    throw new Error(`[${name}] fields cannot include "id". Use rowId or input.id for the row id.`);
  }
};
const resolveNormalize = config => {
  if (!hasFieldsConfig(config)) return config.normalize;
  assertValidFieldsConfig(config.name, config.fields);
  return (0, _schema.createSchema)({
    fields: config.fields,
    rowId: config.rowId,
    guard: config.guard
  }).normalize;
};

/** Create a collection model from a persistent collection and normalizer. */

function createCollectionModel(config) {
  const {
    collection: rawCollection,
    staleTime = 0
  } = config;
  const normalize = resolveNormalize(config);
  const collectionId = typeof rawCollection.id === 'string' && rawCollection.id.length > 0 ? rawCollection.id : null;
  const freshness = createFreshnessTracker(collectionId, staleTime);
  let resetMergeState = () => {};
  const merge = (0, _createMerge.createMerge)({
    collection: rawCollection,
    normalize,
    shouldOverwrite: config.merge?.shouldOverwrite,
    dedupeWindowMs: config.merge?.dedupeWindowMs,
    resolveDedupeWindowMs: () => (0, _modelDefaults.getDbModelDefaults)().merge?.dedupeWindowMs,
    registerReset: reset => {
      resetMergeState = reset;
    }
  });
  const replace = (0, _createReplace.createReplace)({
    collection: rawCollection,
    normalize,
    shouldOverwrite: config.replace?.shouldOverwrite
  });
  const crud = (0, _createPatchCrud.createPatchCrud)({
    collection: rawCollection
  });
  const tanstackCollection = rawCollection._collection;
  const acceptMutations = rawCollection.acceptMutations.bind(rawCollection);
  const withTransaction = fn => {
    if ((0, _registry.isInManagedMutationBatch)()) {
      fn();
      return;
    }
    const tx = (0, _db.createTransaction)({
      mutationFn: ({
        transaction
      }) => {
        acceptMutations(transaction);
        return Promise.resolve();
      }
    });
    tx.mutate(fn);
  };
  const getSnapshotWhere = filter => {
    const results = [];
    for (const item of rawCollection.values()) {
      if ((0, _compileDbWhere.matchesDbWhere)(item, filter)) results.push(item);
    }
    return results;
  };
  const getSnapshotFirstWhere = (filter, options) => {
    const rows = filter ? getSnapshotWhere(filter) : Array.from(rawCollection.values());
    return (0, _compileDbWhere.applyDbReadOptionsToRows)(rows, options)[0];
  };
  const hasCached = filter => {
    if (filter && Object.keys((0, _compileDbWhere.normalizeDbCondition)(filter) ?? {}).length > 0) {
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
    const normalized = (0, _compileDbWhere.normalizeDbCondition)(filter);
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
    (0, _sideload.withApplyingModel)(config.name, () => {
      withTransaction(() => {
        (0, _sideload.runSideloads)(config.sideload, items, contract);
        if (contract.mode === 'replace') {
          const scopeFilter = contract._scopeFilter;
          result = replace(items, scopeFilter);
        } else {
          result = merge(items);
        }
      });
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
    } = (0, _reactDb.useLiveQuery)(q => id ? q.from({
      items: tanstackCollection
    }).where(({
      items
    }) => (0, _db.eq)((0, _typeBoundary.toQueryValue)(items.id), id)).findOne() : undefined, [id]);
    return data;
  };
  const useAll = () => {
    const {
      data
    } = (0, _reactDb.useLiveQuery)(q => {
      let query = q.from({
        items: tanstackCollection
      });
      const defaultSort = config.defaultSort;
      if (defaultSort) {
        query = query.orderBy(({
          items
        }) => (0, _typeBoundary.toQueryValue)(items[defaultSort.field]), defaultSort.direction);
      }
      return query;
    });
    return data ?? EMPTY;
  };
  const useWhere = (filter, options) => {
    const signature = (0, _compileDbWhere.createDbWhereSignature)(filter, options);
    const {
      data
    } = (0, _reactDb.useLiveQuery)(q => (0, _compileDbWhere.applyDbReadOptionsToQuery)((0, _compileDbWhere.applyDbWhereToQuery)(q.from({
      items: tanstackCollection
    }), filter), options), [signature]);
    return data ?? EMPTY;
  };
  const useFirst = (filter, options) => {
    const signature = (0, _compileDbWhere.createDbWhereSignature)(filter, options);
    const {
      data
    } = (0, _reactDb.useLiveQuery)(q => (0, _compileDbWhere.applyDbReadOptionsToQuery)((0, _compileDbWhere.applyDbWhereToQuery)(q.from({
      items: tanstackCollection
    }), filter), options).findOne(), [signature]);
    return data;
  };
  const useByIds = ids => {
    const {
      data
    } = (0, _reactDb.useLiveQuery)(q => ids.length > 0 ? q.from({
      items: tanstackCollection
    }).where(({
      items
    }) => (0, _db.inArray)((0, _typeBoundary.toQueryValue)(items.id), ids)) : undefined, [ids]);
    return data ?? EMPTY;
  };
  const useCount = filter => {
    const signature = (0, _compileDbWhere.createDbWhereSignature)(filter);
    const {
      data
    } = (0, _reactDb.useLiveQuery)(q => (0, _compileDbWhere.applyDbWhereToQuery)(q.from({
      items: tanstackCollection
    }), filter).groupBy(() => GROUP_ALL).select(({
      items
    }) => ({
      total: (0, _db.count)((0, _typeBoundary.toQueryValue)(items.id))
    })), [signature]);
    return data?.[0]?.total ?? 0;
  };
  (0, _registry.registerModelRuntimeReset)(config.name, () => {
    freshness.reset();
    resetMergeState();
  });
  const baseModel = {
    get: id => id ? rawCollection.get(id) : undefined,
    getAll: () => Array.from(rawCollection.values()),
    getWhere: filter => getSnapshotWhere(filter),
    getFirstWhere: (filter, options) => getSnapshotFirstWhere(filter, options),
    getFirst: (filter, options) => getSnapshotFirstWhere(filter, options),
    patch: (id, updates) => crud.patch(id, updates),
    destroy: id => crud.destroy(id),
    destroyMany,
    destroyWhere,
    replaceRaw: (oldId, item) => {
      const normalized = normalize(item);
      if (!normalized) return false;
      (0, _sideload.withApplyingModel)(config.name, () => {
        withTransaction(() => {
          (0, _sideload.runSideloads)(config.sideload, [item], {
            mode: 'merge',
            source: 'sideload'
          });
          rawCollection.delete(oldId);
          rawCollection.insert(normalized);
        });
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
    first: useFirst,
    count: useCount,
    collection: tanstackCollection,
    _collection: tanstackCollection
  };
  const extensions = config.statics?.(baseModel);
  if (!extensions) {
    (0, _modelRegistry.registerModel)(config.name, baseModel);
    return baseModel;
  }
  for (const key of Object.keys(extensions)) {
    if (key in baseModel) {
      throw new Error(`[${config.name}] statics cannot override base model key "${key}".`);
    }
  }
  const model = {
    ...baseModel,
    ...extensions
  };
  (0, _modelRegistry.registerModel)(config.name, model);
  return model;
}
//# sourceMappingURL=createCollectionModel.js.map