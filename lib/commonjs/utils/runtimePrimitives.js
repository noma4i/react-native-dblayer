"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.trimRowsPerScope = exports.singletonStatics = exports.resolveStaleTempRows = exports.reconcileOptimisticRows = exports.pruneOrphanedRows = exports.pruneExpiredRows = exports.createThrottledSingleFlight = exports.createNestedObjectPatcher = exports.createKeyedArrayPatcher = exports.createIdArrayPatcher = void 0;
var _generateTempId = require("./generateTempId.js");
var _shape = require("../schema/shape.js");
const toTimestamp = value => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
};
const createdAtDelta = (candidate, node) => Math.abs(toTimestamp(candidate.createdAt) - toTimestamp(node.createdAt));
const resolveScopedCandidates = (model, scope, node) => {
  const filter = {};
  if ('fields' in scope) {
    for (const field of scope.fields) {
      filter[field] = node[field];
    }
  } else {
    for (const [storedField, nodeField] of Object.entries(scope.fieldMap)) {
      if (!nodeField) continue;
      filter[storedField] = node[nodeField];
    }
  }
  return model.getWhere(filter);
};
const candidateAllowed = (candidate, node, isCandidate) => (0, _generateTempId.isTempId)(candidate.id) || Boolean(isCandidate?.(candidate, node));
const findBestOptimisticCandidate = (candidates, node, options) => {
  let bestCandidate = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidateAllowed(candidate, node, options.isCandidate)) continue;
    if (!options.match(candidate, node)) continue;
    const delta = createdAtDelta(candidate, node);
    if (!Number.isFinite(delta)) continue;
    if (options.createdAtWindowMs !== undefined && delta > options.createdAtWindowMs) continue;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
};

/**
 * Reconcile incoming server nodes with matching optimistic rows.
 * @returns Server nodes that were not matched or skipped as already present.
 */
const reconcileOptimisticRows = (model, nodes, options) => {
  const unmatched = [];
  for (const node of nodes) {
    if (model.get(node.id)) continue;
    const candidates = typeof options.resolveCandidates === 'function' ? options.resolveCandidates(node) : resolveScopedCandidates(model, options.resolveCandidates, node);
    const bestCandidate = findBestOptimisticCandidate(candidates, node, options);
    if (!bestCandidate) {
      unmatched.push(node);
      continue;
    }
    options.commit(bestCandidate.id, node);
  }
  return unmatched;
};
exports.reconcileOptimisticRows = reconcileOptimisticRows;
const normalizeIdSet = ids => ids instanceof Set ? ids : new Set(ids);
const destroyManyIfNeeded = (model, ids) => ids.length > 0 ? model.destroyMany(ids) : 0;
const deleteManyForMaintenance = (model, ids) => {
  if (ids.length === 0) return 0;
  return model._deleteManyWithoutFreshness?.(ids) ?? model.destroyMany(ids);
};
const toExpiryTimestamp = value => toTimestamp(value);

/** Delete rows whose foreign key no longer points at a live parent id. */
const pruneOrphanedRows = (model, foreignKeyField, liveParentIds) => {
  const liveIds = normalizeIdSet(liveParentIds);
  const idsToDestroy = model.getAll().filter(row => {
    const foreignId = row[foreignKeyField];
    return typeof foreignId !== 'string' && typeof foreignId !== 'number' || !liveIds.has(String(foreignId));
  }).map(row => row.id);
  return destroyManyIfNeeded(model, idsToDestroy);
};

/** Delete rows whose timestamp field is older than the supplied TTL. Invalid timestamps are kept. */
exports.pruneOrphanedRows = pruneOrphanedRows;
const pruneExpiredRows = (model, field, ttlMs, now = Date.now()) => {
  const nowMs = toExpiryTimestamp(now);
  if (!Number.isFinite(nowMs)) return 0;
  const idsToDestroy = model.getAll().filter(row => {
    const timestamp = toExpiryTimestamp(row[field]);
    return Number.isFinite(timestamp) && nowMs - timestamp > ttlMs;
  }).map(row => row.id);
  return destroyManyIfNeeded(model, idsToDestroy);
};
exports.pruneExpiredRows = pruneExpiredRows;
const toProtectPredicate = protect => {
  if (!protect) return () => false;
  if (typeof protect === 'function') return protect;
  const ids = normalizeIdSet(protect);
  return row => ids.has(row.id);
};

/**
 * Keep at most `maxPerScope` unprotected rows in each scope.
 * The supplied comparator must order rows from newest/most important to oldest.
 */
const trimRowsPerScope = (model, scopeField, maxPerScope, compare, protect) => {
  const shouldProtect = toProtectPredicate(protect);
  const groups = new Map();
  for (const row of model.getAll()) {
    if (shouldProtect(row)) continue;
    const scopeValue = row[scopeField];
    if (scopeValue == null) continue;
    const scopeKey = String(scopeValue);
    const group = groups.get(scopeKey);
    if (group) {
      group.push(row);
    } else {
      groups.set(scopeKey, [row]);
    }
  }
  const limit = Math.max(0, maxPerScope);
  const idsToDestroy = [];
  for (const rows of groups.values()) {
    if (rows.length <= limit) continue;
    rows.sort(compare);
    idsToDestroy.push(...rows.slice(limit).map(row => row.id));
  }
  return deleteManyForMaintenance(model, idsToDestroy);
};
exports.trimRowsPerScope = trimRowsPerScope;
/** Run `onStale` for temp-id rows older than the age threshold and not protected. */
const resolveStaleTempRows = (model, options) => {
  const protectedIds = options.protectedIds ? normalizeIdSet(options.protectedIds) : new Set();
  const now = Date.now();
  let resolved = 0;
  for (const row of model.getAll()) {
    if (!(0, _generateTempId.isTempId)(row.id) || protectedIds.has(row.id)) continue;
    const createdAt = toTimestamp(row.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt <= options.maxAgeMs) continue;
    options.onStale(row);
    resolved += 1;
  }
  return resolved;
};
exports.resolveStaleTempRows = resolveStaleTempRows;
const defaultIsForced = arg => typeof arg === 'object' && arg !== null && arg.force === true;

/**
 * Coalesce concurrent calls and suppress calls inside the post-success interval.
 * Suppressed calls and failed executions resolve to `undefined`.
 */
const createThrottledSingleFlight = (fn, options) => {
  let inFlight = null;
  let lastSuccessAt = 0;
  return (...args) => {
    if (inFlight) return inFlight;
    const force = options.isForced ? options.isForced(...args) : defaultIsForced(args[0]);
    if (!force && Date.now() - lastSuccessAt < options.minIntervalMs) {
      return Promise.resolve(undefined);
    }
    try {
      inFlight = fn(...args).then(result => {
        lastSuccessAt = Date.now();
        return result;
      }).catch(() => undefined).finally(() => {
        inFlight = null;
      });
    } catch {
      inFlight = Promise.resolve(undefined).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
};
exports.createThrottledSingleFlight = createThrottledSingleFlight;
/** Create immutable patch helpers for an array of keyed shape sub-rows. */
const createKeyedArrayPatcher = (shape, options) => ({
  upsert(rows, input) {
    const next = (0, _shape.readShapeOrThrow)(shape, input, 'Keyed array patch item');
    const keyValue = next[options.key];
    return [...(rows ?? []).filter(entry => entry[options.key] !== keyValue), next];
  },
  remove(rows, keyValue) {
    return (rows ?? []).filter(entry => entry[options.key] !== keyValue);
  }
});

/** Create immutable patch helpers for id arrays. */
exports.createKeyedArrayPatcher = createKeyedArrayPatcher;
const createIdArrayPatcher = () => ({
  upsert(ids, id, position) {
    const next = (ids ?? []).filter(existingId => existingId !== id);
    return position === 'prepend' ? [id, ...next] : [...next, id];
  },
  remove(ids, id) {
    return (ids ?? []).filter(existingId => existingId !== id);
  }
});

/** Create a shallow patcher for a nullable nested object field. */
exports.createIdArrayPatcher = createIdArrayPatcher;
const createNestedObjectPatcher = (model, field, transform) => {
  return (id, ...args) => {
    const row = model.get(id);
    const current = row?.[field];
    if (typeof current !== 'object' || current === null) return false;
    model.patch(id, {
      [field]: {
        ...current,
        ...transform(current, ...args)
      }
    });
    return true;
  };
};
exports.createNestedObjectPatcher = createNestedObjectPatcher;
const removeSingletonId = input => {
  const {
    id: _ignoredId,
    ...updates
  } = input;
  return updates;
};

/** Build statics for a single-row model with defaults and clamped numeric updates. */
const singletonStatics = (model, recordId, defaults) => {
  const upsert = input => {
    const updates = removeSingletonId(input);
    const existing = model.get(recordId);
    if (existing) {
      model.patch(recordId, updates);
      return;
    }
    model.insertStored({
      ...defaults,
      ...updates,
      id: recordId
    });
  };
  return {
    recordId,
    defaults,
    current: () => model.get(recordId),
    useCurrent: () => model.find(recordId) ?? defaults,
    upsert,
    upsertCurrent: upsert,
    patchClamped: (field, delta, min = 0) => {
      if (delta === 0) return false;
      const current = model.get(recordId);
      if (!current) return false;
      const value = current[field];
      const currentValue = typeof value === 'number' ? value : 0;
      return model.patch(recordId, {
        [field]: Math.max(min, currentValue + delta)
      }) !== false;
    }
  };
};
exports.singletonStatics = singletonStatics;
//# sourceMappingURL=runtimePrimitives.js.map