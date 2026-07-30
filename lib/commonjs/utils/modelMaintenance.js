"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.trimRowsPerScope = exports.resolveStaleTempRows = void 0;
var _generateTempId = require("./generateTempId.js");
var _normalizeHelpers = require("./normalizeHelpers.js");
var _ordering = require("../core/ordering.js");
const normalizeIdSet = ids => ids instanceof Set ? ids : new Set(ids);
const deleteManyForMaintenance = (model, ids) => {
  if (ids.length === 0) return 0;
  model.destroyMany(ids);
  return ids.length;
};
const toProtectPredicate = protect => {
  if (typeof protect === 'function') return protect;
  const ids = normalizeIdSet(protect);
  return row => ids.has(row.id);
};

/**
 * Keep at most `maxPerScope` unprotected rows in each scope.
 *
 * The supplied comparator must order rows from newest/most important to oldest.
 *
 * @param model Model that can snapshot rows and delete rows for maintenance.
 * @param scopeField Row field used to group rows.
 * @param maxPerScope Maximum unprotected rows kept per scope.
 * @param compare Comparator applied inside each scope before trimming.
 * @param protect Optional protected row predicate or id list.
 * @returns Number of rows deleted.
 */
const trimRowsPerScope = (model, scopeField, maxPerScope, compare, protect) => {
  const shouldProtect = toProtectPredicate(protect);
  const groups = new Map();
  for (const row of model.all()) {
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
    rows.sort((0, _ordering.withIdTieBreak)(compare));
    idsToDestroy.push(...rows.slice(limit).map(row => row.id));
  }
  return deleteManyForMaintenance(model, idsToDestroy);
};

/**
 * Run `onStale` for temp-id rows older than the age threshold and not protected. A row whose
 * `createdAt` cannot be parsed (missing, malformed, or otherwise NaN) is treated as maximally old and
 * resolved immediately - an unparseable timestamp must not grant a stale row indefinite protection
 * from cleanup.
 *
 * @param model Snapshot model used to scan temp rows.
 * @param options Age threshold, optional protected ids, and stale-row callback.
 * @returns Number of stale temp rows resolved.
 */
exports.trimRowsPerScope = trimRowsPerScope;
const resolveStaleTempRows = (model, options) => {
  const protectedIds = options.protectedIds ? normalizeIdSet(options.protectedIds) : new Set();
  const now = Date.now();
  let resolved = 0;
  for (const row of model.all()) {
    if (!(0, _generateTempId.isTempId)(row.id) || protectedIds.has(row.id)) continue;
    const createdAt = (0, _normalizeHelpers.toTimestamp)(row.createdAt);
    const age = Number.isFinite(createdAt) ? now - createdAt : Number.POSITIVE_INFINITY;
    if (age <= options.maxAgeMs) continue;
    options.onStale(row);
    resolved += 1;
  }
  return resolved;
};
exports.resolveStaleTempRows = resolveStaleTempRows;
//# sourceMappingURL=modelMaintenance.js.map