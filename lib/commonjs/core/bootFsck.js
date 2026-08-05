"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runBootFsck = void 0;
var _configure = require("../dsl/configure.js");
var _maintenanceRegistry = require("../dsl/maintenanceRegistry.js");
var _commitEnvelope = require("./apply/commitEnvelope.js");
var _applyTargetRegistry = require("./apply/applyTargetRegistry.js");
var _internalHandles = require("./internalHandles.js");
var _quarantine = require("./quarantine.js");
var _requestRollback = require("./requestRollback.js");
var _serialize = require("./serialize.js");
var _generateTempId = require("../utils/generateTempId.js");
/**
 * THE boot integrity pass. The delta log makes every commit durable and atomic, so no torn
 * row/membership shape exists to repair; what remains is operation truth: a crashed pending
 * request closes exactly like a runtime transport failure, an ownerless temp row is quarantined,
 * and a quarantined row that the current codecs accept again is restored.
 */

const hasApplyTarget = model => {
  try {
    (0, _applyTargetRegistry.getApplyTarget)(model);
    return true;
  } catch {
    return false;
  }
};

/** A kill mid-mutation closes exactly like a runtime transport failure: THE shared rollback planner, field-level for patches, retryable always. */
const closeCrashedRequests = () => {
  const operations = (0, _configure.getOperationState)();
  const crashedRequests = operations.takeHydratedPending(operation => operation.actionMode === 'request');
  if (crashedRequests.length === 0) return;
  const recoveryOps = [];
  const recoveryTransitions = [];
  for (const operation of crashedRequests) {
    const planned = (0, _requestRollback.planRequestFailureRollback)(operation, id => hasApplyTarget(operation.model) ? (0, _applyTargetRegistry.getApplyTarget)(operation.model).readRow(id) : undefined,
    // THE model-owned restore plan: the fsck restore is byte-identical to the runtime
    // transport-failure restore, relation effects (counter, touch) included.
    (row, memberships) => (0, _internalHandles.getInternalModelHandleById)(operation.model).planRestore(row, memberships));
    recoveryOps.push(...planned.ops);
    recoveryTransitions.push(planned.transition);
  }
  (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)(recoveryOps, recoveryTransitions));
};

/** An ownerless temp row leaves the store, but its payload is quarantined - never dropped. */
const quarantineOrphanTempRows = () => {
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  const operations = (0, _configure.getOperationState)();
  const rowPrefix = (0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'row');
  const candidates = new Map();
  for (const key of storage.keys(rowPrefix)) {
    const parts = (0, _serialize.parseCompositeKey)(key.slice(rowPrefix.length));
    if (parts?.length !== 2) continue;
    const [model, id] = parts;
    if (!(0, _generateTempId.isTempId)(id)) continue;
    const ids = candidates.get(model) ?? new Set();
    ids.add(id);
    candidates.set(model, ids);
  }
  const openTempIds = new Set(operations.open().flatMap(operation => operation.tempIds.map(id => (0, _serialize.compositeKey)(operation.model, id))));
  for (const [model, ids] of candidates) {
    const orphanIds = [...ids].filter(id => !openTempIds.has((0, _serialize.compositeKey)(model, id)) && !operations.failedFor(model, id) && !(0, _maintenanceRegistry.isTempRowProtectedByModel)(model, id));
    if (orphanIds.length === 0 || !hasApplyTarget(model)) continue;
    for (const id of orphanIds) {
      const raw = storage.get((0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'row', model, id));
      // A missing payload becomes a placeholder: the orphan destroy always carries its ticket.
      (0, _quarantine.putQuarantine)({
        kind: 'row',
        model,
        id,
        raw: raw ?? {
          placeholder: 'missing-row-payload'
        },
        reason: 'orphan-temp-row'
      });
    }
    (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
      kind: 'destroy',
      model,
      ids: orphanIds,
      tombstone: false
    }]));
  }
};

/** A quarantined row that the current codecs admit again returns to its model and drops its ticket. */
const restoreReadmittedRows = () => {
  const readmits = entry => {
    if (entry.kind !== 'row' || entry.reason !== 'plan-row-rejected' || !hasApplyTarget(entry.model)) return false;
    try {
      return (0, _applyTargetRegistry.getApplyTarget)(entry.model).prepareUpsert(entry.raw, undefined, undefined, undefined, undefined, undefined) !== null;
    } catch {
      return false;
    }
  };
  const restored = (0, _quarantine.readQuarantineEntries)().filter(readmits);
  if (restored.length === 0) return;
  for (const entry of restored) {
    (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
      kind: 'upsert',
      model: entry.model,
      rows: [entry.raw]
    }]));
  }
  // The restore envelope is durable first; a kill before this removal re-restores idempotently.
  (0, _quarantine.takeQuarantineEntries)(readmits);
};

/** Run every boot integrity check once, after hydrate and before the first render that reads a model. */
const runBootFsck = () => {
  closeCrashedRequests();
  quarantineOrphanTempRows();
  restoreReadmittedRows();
};
exports.runBootFsck = runBootFsck;
//# sourceMappingURL=bootFsck.js.map