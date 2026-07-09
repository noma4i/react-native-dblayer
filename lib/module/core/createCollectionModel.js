"use strict";

import { createTransaction, count as dbCount, eq, inArray } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { createSchema } from "../schema/schema.js";
import { toQueryValue } from "../utils/typeBoundary.js";
import { applyDbReadOptionsToQuery, applyDbReadOptionsToRows, applyDbWhereToQuery, buildScopeKey, createDbWhereSignature, matchesDbWhere, normalizeDbCondition, ROOT_SCOPE_KEY } from "./compileDbWhere.js";
import { createMerge } from "./createMerge.js";
import { createPatchCrud } from "./createPatchCrud.js";
import { createReplace } from "./createReplace.js";
import { clearCollectionFetchState, clearCollectionFetchStates, getCollectionFetchState, listCollectionFetchScopes, registerCollectionFetchStateCache, setCollectionFetchState } from "./freshnessStorage.js";
import { getDbLogger } from "./logger.js";
import { getDbModelDefaults } from "./modelDefaults.js";
import { createMirrorPropagator } from "./modelMirror.js";
import { registerModel } from "./modelRegistry.js";
import { attachRowRelated, buildRelatedAccessors, getCascadeController, propagateBelongsToParents, registerCascadeController, relationValues, touchBelongsToParents } from "./relations.js";
import { isInManagedMutationBatch, registerModelRuntimeReset } from "./registry.js";
import { isModelApplying, runSideloads, withApplyingModel } from "./sideload.js";
import { clearRowWaitersForCollection } from "./rowWaiters.js";
import { createWritePropagation } from "./writePropagation.js";
const EMPTY = [];
const GROUP_ALL = 1;
const buildFetchScope = filter => {
  const normalized = normalizeDbCondition(filter);
  return normalized ? {
    scope: buildScopeKey(filter),
    filter: normalized
  } : {
    scope: ROOT_SCOPE_KEY
  };
};
const createFreshnessTracker = (modelName, collectionId, staleTime, emptyStaleTime) => {
  const fetchStateCache = new Map();
  if (collectionId) {
    fetchStateCache.set(ROOT_SCOPE_KEY, getCollectionFetchState(collectionId));
    registerCollectionFetchStateCache(collectionId, scopeKey => {
      fetchStateCache.delete(scopeKey ?? ROOT_SCOPE_KEY);
    });
  }
  const getFetchState = filter => {
    const {
      scope
    } = buildFetchScope(filter);
    if (fetchStateCache.has(scope)) {
      return fetchStateCache.get(scope) ?? null;
    }
    const nextState = collectionId ? getCollectionFetchState(collectionId, scope === ROOT_SCOPE_KEY ? undefined : scope) : null;
    fetchStateCache.set(scope, nextState);
    return nextState;
  };
  const markFetched = (filter, state) => {
    const {
      scope,
      filter: normalizedFilter
    } = buildFetchScope(filter);
    const nextState = {
      touchedAt: Date.now(),
      empty: state?.empty === true,
      ...(state?.pageInfo ? {
        pageInfo: state.pageInfo
      } : {})
    };
    fetchStateCache.set(scope, nextState);
    if (collectionId) {
      setCollectionFetchState(collectionId, nextState, scope === ROOT_SCOPE_KEY ? undefined : scope, normalizedFilter);
    }
  };
  const touch = () => {
    markFetched(undefined, {
      empty: false
    });
  };
  const clearFetchState = filter => {
    const {
      scope,
      filter: normalizedFilter
    } = buildFetchScope(filter);
    fetchStateCache.delete(scope);
    if (collectionId) {
      getDbLogger().debug('db', 'freshness:clear', {
        model: modelName,
        scope: normalizedFilter
      });
      clearCollectionFetchState(collectionId, scope === ROOT_SCOPE_KEY ? undefined : scope);
    }
  };
  const isStale = (filter, maxAgeMs = staleTime, emptyMaxAgeMs = emptyStaleTime) => {
    const fetchState = getFetchState(filter);
    if (!fetchState) return true;
    const effectiveMaxAgeMs = fetchState.empty ? emptyMaxAgeMs : maxAgeMs;
    if (effectiveMaxAgeMs <= 0) return true;
    return Date.now() - fetchState.touchedAt > effectiveMaxAgeMs;
  };
  const shouldSkipInitialFetch = (hasItems, filter, maxAgeMs = staleTime, emptyMaxAgeMs = emptyStaleTime) => {
    const fetchState = getFetchState(filter);
    if (fetchState?.empty === true) {
      return !isStale(filter, maxAgeMs, emptyMaxAgeMs);
    }
    return hasItems(filter) && !isStale(filter, maxAgeMs, emptyMaxAgeMs);
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
const hasFieldsConfig = config => 'fields' in config;
const assertValidFieldsConfig = (name, fields) => {
  if (Object.prototype.hasOwnProperty.call(fields, 'id')) {
    throw new Error(`[${name}] fields cannot include "id". Use rowId or input.id for the row id.`);
  }
};
const resolveNormalize = config => {
  if (!hasFieldsConfig(config)) return config.normalize;
  assertValidFieldsConfig(config.name, config.fields);
  return createSchema({
    fields: config.fields,
    rowId: config.rowId,
    guard: config.guard
  }).normalize;
};
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const hasFactoryDefault = field => hasOwn(field, 'factoryDefault');
const resolveFactoryDefault = field => {
  const value = field.factoryDefault;
  return typeof value === 'function' ? value() : value;
};
const createStoredRowBuilder = (name, fields) => partial => {
  const input = typeof partial === 'object' && partial !== null ? partial : {};
  if (!hasOwn(input, 'id')) {
    throw new Error(`[${name}] buildStored missing required field "id".`);
  }
  const output = {
    ...input
  };
  for (const key of Object.keys(fields)) {
    if (hasOwn(input, key)) continue;
    const field = fields[key];
    if (hasFactoryDefault(field)) {
      output[key] = resolveFactoryDefault(field);
    } else if (field.mode === 'nullable') {
      output[key] = null;
    } else if (field.mode === 'required') {
      throw new Error(`[${name}] buildStored missing required field "${key}".`);
    }
  }
  return output;
};

/**
 * Create a collection model from a persistent collection, normalizer, and relations.
 *
 * @param config Collection id, storage collection, normalize function, optional statics, freshness settings, sideloads, and lazy relations.
 * @returns A reactive collection model extended with supplied statics and relation accessors.
 */

/**
 * Create a collection model from a persistent collection and normalizer.
 *
 * @param config Collection id, storage collection, normalize function, optional statics, freshness settings, and sideloads.
 * @returns A reactive collection model extended with supplied statics.
 */

/**
 * Create a fields-schema model with relation accessors and generated normalize/buildStored helpers.
 *
 * @param config Collection id, fields schema, optional rowId/guard/statics/freshness settings/sideloads, and lazy relations.
 * @returns A reactive fields collection model extended with supplied statics and relation accessors.
 */

/**
 * Create a fields-schema model with generated normalize/buildStored helpers.
 *
 * @param config Collection id, fields schema, optional rowId/guard/statics/freshness settings, and sideloads.
 * @returns A reactive fields collection model extended with supplied statics.
 */

export function createCollectionModel(config) {
  const {
    collection: rawCollection,
    staleTime = 0,
    emptyStaleTime = 0
  } = config;
  const normalizeBase = resolveNormalize(config);
  let attachRelatedToRow = row => row;
  const writePropagation = createWritePropagation();
  const normalize = item => {
    const normalized = normalizeBase(item);
    return normalized ? attachRelatedToRow(normalized) : null;
  };
  const collectionId = typeof rawCollection.id === 'string' && rawCollection.id.length > 0 ? rawCollection.id : null;
  const freshness = createFreshnessTracker(config.name, collectionId, staleTime, emptyStaleTime);
  let resetMergeState = () => {};
  let relationCache = null;
  let relatedAccessorsCache;
  const runtimeCollection = {
    get id() {
      return rawCollection.id;
    },
    get: id => {
      const row = rawCollection.get(id);
      return row ? attachRelatedToRow(row) : undefined;
    },
    has: id => rawCollection.has(id),
    insert: item => {
      const row = attachRelatedToRow(item);
      rawCollection.insert(row);
      writePropagation.announce(row, 'insert');
    },
    update: (id, updater) => {
      let snapshot;
      rawCollection.update(id, draft => {
        updater(draft);
        snapshot = {
          ...draft
        };
      });
      if (snapshot) {
        attachRelatedToRow(snapshot);
        writePropagation.announce(snapshot, 'update');
      }
    },
    delete: id => rawCollection.delete(id),
    keys: () => rawCollection.keys(),
    values: () => rawCollection.values(),
    get size() {
      return rawCollection.size;
    },
    acceptMutations: rawCollection.acceptMutations
  };
  const merge = createMerge({
    collection: runtimeCollection,
    normalize,
    shouldOverwrite: config.merge?.shouldOverwrite,
    dedupeWindowMs: config.merge?.dedupeWindowMs,
    resolveDedupeWindowMs: () => getDbModelDefaults().merge?.dedupeWindowMs,
    registerReset: reset => {
      resetMergeState = reset;
    }
  });
  const replace = createReplace({
    collection: runtimeCollection,
    normalize,
    shouldOverwrite: config.replace?.shouldOverwrite
  });
  const crud = createPatchCrud({
    collection: runtimeCollection
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
  const getSnapshotWhere = filter => {
    const results = [];
    for (const item of rawCollection.values()) {
      if (matchesDbWhere(item, filter)) results.push(attachRelatedToRow(item));
    }
    return results;
  };
  const getSnapshotFirstWhere = (filter, options) => {
    const rows = filter ? getSnapshotWhere(filter) : attachRelatedToRows(Array.from(rawCollection.values()));
    return applyDbReadOptionsToRows(rows, options)[0];
  };
  const hasCached = filter => {
    if (filter && Object.keys(normalizeDbCondition(filter) ?? {}).length > 0) {
      return getSnapshotFirstWhere(filter) !== undefined;
    }
    if ('size' in rawCollection && typeof rawCollection.size === 'number') {
      return rawCollection.size > 0;
    }
    for (const _ of rawCollection.keys()) return true;
    return false;
  };
  const shouldSkipInitialFetch = (filter, maxAgeMs, emptyMaxAgeMs) => freshness.shouldSkipInitialFetch(hasCached, filter, maxAgeMs, emptyMaxAgeMs);
  const resolveRelationMap = () => {
    if (relationCache !== null) return relationCache;
    const nextRelations = config.relations?.() ?? {};
    relationCache = nextRelations;
    return nextRelations;
  };
  const resolveRelations = () => relationValues(resolveRelationMap());
  const hasRelations = () => typeof config.relations === 'function';
  const resolveRelatedAccessors = () => {
    if (!relatedAccessorsCache) {
      relatedAccessorsCache = buildRelatedAccessors(config.name, resolveRelationMap, {
        collection: tanstackCollection,
        getRow: id => {
          const row = id ? rawCollection.get(id) : undefined;
          return row ? attachRelatedToRow(row) : undefined;
        }
      });
    }
    return relatedAccessorsCache;
  };
  attachRelatedToRow = row => {
    if (!hasRelations()) return row;
    return attachRowRelated(config.name, row, resolveRelationMap, resolveRelatedAccessors);
  };
  writePropagation.register(row => {
    if (!hasRelations() || isModelApplying(config.name)) return;
    touchBelongsToParents(resolveRelationMap(), row);
  });
  writePropagation.register(row => {
    if (!hasRelations()) return;
    propagateBelongsToParents(resolveRelationMap(), row);
  });
  const mirrorPropagator = createMirrorPropagator(config.name, config.mirror);
  if (mirrorPropagator) {
    writePropagation.register(mirrorPropagator);
  }
  const attachRelatedToRows = rows => {
    if (!hasRelations() || rows.length === 0) return rows;
    for (const row of rows) {
      attachRelatedToRow(row);
    }
    return rows;
  };
  const attachHydratedRows = () => {
    if (!hasRelations()) return;
    attachRelatedToRows(Array.from(rawCollection.values()));
  };
  if (hasRelations()) {
    if (tanstackCollection.isReady()) {
      attachHydratedRows();
    } else {
      void tanstackCollection.stateWhenReady().then(attachHydratedRows, () => {});
    }
  }
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
  const scopeMatchesRow = (scope, row) => Object.entries(scope).every(([field, value]) => row[field] === value);
  const clearFetchStatesForRows = rows => {
    if (!collectionId || rows.length === 0) return;
    for (const record of listCollectionFetchScopes(collectionId)) {
      if (!record.scopeKey || !record.scope) continue;
      const scope = record.scope;
      if (rows.some(row => scopeMatchesRow(scope, row))) {
        clearCollectionFetchState(collectionId, record.scopeKey);
      }
    }
  };
  const deleteManyWithoutCascade = (ids, options) => {
    let deleted = 0;
    const rowsToDelete = options?.clearFreshness === false ? [] : ids.map(id => rawCollection.get(id)).filter(row => Boolean(row));
    withTransaction(() => {
      for (const id of ids) {
        if (!rawCollection.has(id)) continue;
        rawCollection.delete(id);
        deleted += 1;
      }
    });
    clearFetchStatesForRows(rowsToDelete);
    return deleted;
  };
  const cascadeDependents = (victimIds, visitedModelNames) => {
    if (!hasRelations() || victimIds.length === 0) return;
    const relations = resolveRelations();
    if (relations.length === 0) return;
    const victimSet = new Set(victimIds);
    for (const relation of relations) {
      if (relation.kind !== 'hasMany' || relation.dependent !== 'destroy') continue;
      const childController = getCascadeController(relation.model);
      if (!childController) {
        throw new Error(`[${config.name}] relation "${relation.foreignKey}" target is not registered for cascade destroy.`);
      }
      const childIds = childController.getIdsWhereFieldIn(relation.foreignKey, victimSet);
      if (childIds.length === 0) continue;
      childController.destroyManyWithCascade(childIds, visitedModelNames);
    }
  };
  const destroyManyWithCascade = (ids, visitedModelNames) => {
    const victimIds = ids.filter((id, index) => ids.indexOf(id) === index && rawCollection.has(id));
    if (victimIds.length === 0) return 0;
    if (visitedModelNames.has(config.name)) return deleteManyWithoutCascade(victimIds);
    const nextVisitedModelNames = new Set(visitedModelNames);
    nextVisitedModelNames.add(config.name);
    cascadeDependents(victimIds, nextVisitedModelNames);
    const deletedDuringCascade = victimIds.filter(id => !rawCollection.has(id)).length;
    return deletedDuringCascade + deleteManyWithoutCascade(victimIds);
  };
  const destroyMany = ids => destroyManyWithCascade(ids, new Set());
  const destroyWhere = filter => {
    const normalized = normalizeDbCondition(filter);
    if (!normalized) {
      throw new Error(`[${config.name}] destroyWhere requires a non-empty filter. Use clearScope() for full collection clears.`);
    }
    return destroyMany(getSnapshotWhere(normalized).map(item => item.id));
  };
  const applyServerData = (items, contract) => {
    // `createCollectionBinding`'s `applyServerData` wrapper is the only caller that enriches a plain
    // `SyncContract` with `_scopeFilter`/`_freshnessFilter` before reaching here - see `InternalSyncContract`.
    const internalContract = contract;
    if (internalContract.mode === 'replace' && internalContract.scope !== undefined && internalContract._scopeFilter === undefined) {
      throw new Error(`[${config.name}] scoped replace requires _scopeFilter. Use createCollectionBinding(...).applyServerData() or provide contract._scopeFilter explicitly.`);
    }
    let result = {
      merged: 0
    };
    withApplyingModel(config.name, () => {
      withTransaction(() => {
        runSideloads(config.sideload, items, contract);
        if (internalContract.mode === 'replace') {
          const scopeFilter = internalContract._scopeFilter;
          result = replace(items, scopeFilter);
        } else {
          result = merge(items);
        }
      });
    });
    if (internalContract._freshnessFilter) {
      freshness.markFetched(internalContract._freshnessFilter, {
        empty: items.length === 0
      });
    } else if (internalContract.scope === undefined && internalContract._scopeFilter === undefined) {
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
    return data ? attachRelatedToRow(data) : undefined;
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
    return attachRelatedToRows(data ?? EMPTY);
  };
  const useWhere = (filter, options) => {
    const signature = createDbWhereSignature(filter, options);
    const {
      data
    } = useLiveQuery(q => applyDbReadOptionsToQuery(applyDbWhereToQuery(q.from({
      items: tanstackCollection
    }), filter), options), [signature]);
    return attachRelatedToRows(data ?? EMPTY);
  };
  const useFirst = (filter, options) => {
    const signature = createDbWhereSignature(filter, options);
    const {
      data
    } = useLiveQuery(q => applyDbReadOptionsToQuery(applyDbWhereToQuery(q.from({
      items: tanstackCollection
    }), filter), options).findOne(), [signature]);
    return data ? attachRelatedToRow(data) : undefined;
  };
  const useByIds = ids => {
    const {
      data
    } = useLiveQuery(q => ids.length > 0 ? q.from({
      items: tanstackCollection
    }).where(({
      items
    }) => inArray(toQueryValue(items.id), ids)) : undefined, [ids]);
    return attachRelatedToRows(data ?? EMPTY);
  };
  const useCount = (...args) => {
    const filter = args[0];
    // An explicit nullish filter (caller passed an argument that resolved to null/undefined) disables
    // the count query - it does not skip the hook. `useLiveQuery` still runs on every call; only the
    // query builder's return value is gated, matching nullish scoped read behavior in collection bindings.
    const disabled = args.length > 0 && filter == null;
    const signature = createDbWhereSignature(filter);
    const {
      data
    } = useLiveQuery(q => {
      if (disabled) return undefined;
      return applyDbWhereToQuery(q.from({
        items: tanstackCollection
      }), filter).groupBy(() => GROUP_ALL).select(({
        items
      }) => ({
        total: dbCount(toQueryValue(items.id))
      }));
    }, [disabled, signature]);
    return data?.[0]?.total ?? 0;
  };
  registerModelRuntimeReset(config.name, () => {
    freshness.reset();
    resetMergeState();
    clearRowWaitersForCollection(tanstackCollection);
  });
  const getIdsWhereFieldIn = (field, values) => {
    const ids = [];
    for (const row of rawCollection.values()) {
      const value = row[field];
      if (typeof value === 'string' && values.has(value)) {
        ids.push(row.id);
      }
    }
    return ids;
  };
  const registerModelCascadeController = model => {
    registerCascadeController(model, {
      modelName: config.name,
      attachRowRelated: row => attachRelatedToRow(row),
      destroyManyWithCascade,
      getIdsWhereFieldIn,
      getRelation: name => hasRelations() ? resolveRelationMap()[name] : undefined
    });
  };
  const baseModel = {
    get: id => {
      const row = id ? rawCollection.get(id) : undefined;
      return row ? attachRelatedToRow(row) : undefined;
    },
    getAll: () => attachRelatedToRows(Array.from(rawCollection.values())),
    getWhere: filter => getSnapshotWhere(filter),
    getFirst: (filter, options) => getSnapshotFirstWhere(filter, options),
    patch: (id, updates) => {
      const changed = crud.patch(id, updates);
      if (changed) {
        const row = rawCollection.get(id);
        if (row) attachRelatedToRow(row);
      }
      return changed;
    },
    destroy: id => destroyMany([id]) === 1,
    destroyMany,
    destroyWhere,
    _deleteManyWithoutFreshness: ids => deleteManyWithoutCascade(ids, {
      clearFreshness: false
    }),
    replaceRaw: (oldId, item) => {
      const normalized = normalize(item);
      if (!normalized) return false;
      withTransaction(() => {
        withApplyingModel(config.name, () => {
          runSideloads(config.sideload, [item], {
            mode: 'merge',
            source: 'sideload'
          });
        });
        rawCollection.delete(oldId);
        runtimeCollection.insert(normalized);
      });
      return true;
    },
    insertStored: item => {
      runtimeCollection.insert(item);
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
    collection: tanstackCollection
  };
  const modelBase = hasFieldsConfig(config) ? {
    ...baseModel,
    buildStored: createStoredRowBuilder(config.name, config.fields)
  } : baseModel;
  registerModelCascadeController(modelBase);
  const attachRelatedAccessors = model => {
    if (!hasRelations()) return model;
    Object.defineProperty(model, 'related', {
      enumerable: true,
      configurable: false,
      get() {
        return resolveRelatedAccessors();
      }
    });
    return model;
  };
  const extensions = config.statics?.(modelBase);
  if (!extensions) {
    const model = attachRelatedAccessors(modelBase);
    registerModel(config.name, model);
    return model;
  }
  for (const key of Object.keys(extensions)) {
    if (key in modelBase) {
      throw new Error(`[${config.name}] statics cannot override base model key "${key}".`);
    }
  }
  const model = {
    ...modelBase,
    ...extensions
  };
  const modelWithRelated = attachRelatedAccessors(model);
  registerModelCascadeController(modelWithRelated);
  registerModel(config.name, modelWithRelated);
  return modelWithRelated;
}
//# sourceMappingURL=createCollectionModel.js.map