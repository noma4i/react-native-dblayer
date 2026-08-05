"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runBootFsck = void 0;
var _configure = require("../dsl/configure.js");
var _maintenanceRegistry = require("../dsl/maintenanceRegistry.js");
var _commitEnvelope = require("./apply/commitEnvelope.js");
var _applyTargetRegistry = require("./apply/applyTargetRegistry.js");
var _diagnostics = require("./diagnostics.js");
var _quarantine = require("./quarantine.js");
var _serialize = require("./serialize.js");
var _generateTempId = require("../utils/generateTempId.js");
/**
 * THE boot integrity pass. Persistence is immediate, so a crash can leave the namespace with a
 * partially-written commit; every check below repairs one partial-write shape without dropping
 * user data: a crashed pending request closes as retryable, an ownerless temp row is quarantined,
 * a scope entry without a row detaches with a counter, and a quarantined row that the current
 * codecs accept again is restored.
 */

const hasApplyTarget = model => {
  try {
    (0, _applyTargetRegistry.getApplyTarget)(model);
    return true;
  } catch {
    return false;
  }
};

/** A kill mid-mutation closes exactly like a runtime transport failure: the row rolls back, the operation stays retryable, an unsent insert is never destroyed. */
const closeCrashedRequests = () => {
  const operations = (0, _configure.getOperationState)();
  const crashedRequests = operations.takeHydratedPending(operation => operation.actionMode === 'request');
  if (crashedRequests.length === 0) return;
  const recoveryOps = [];
  const recoveryTransitions = [];
  for (const operation of crashedRequests) {
    const rollbackRow = operation.rollbackRow;
    const rollbackMemberships = operation.rollbackMemberships;
    if (rollbackRow !== undefined && rollbackMemberships !== undefined) {
      recoveryOps.push({
        kind: 'upsert',
        model: operation.model,
        rows: [rollbackRow],
        origin: 'replace'
      });
      for (const membership of rollbackMemberships) {
        recoveryOps.push({
          kind: 'scope-delta',
          model: operation.model,
          scopeKey: membership.scopeKey,
          append: [{
            id: membership.id,
            orderKey: membership.orderKey
          }],
          detach: [membership.id]
        });
      }
    }
    const retryable = operation.tempIds.length > 0 || rollbackRow !== undefined;
    recoveryTransitions.push({
      kind: 'close',
      operationId: operation.operationId,
      status: retryable ? 'failed' : 'rolledback'
    });
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
      if (raw !== undefined) (0, _quarantine.putQuarantine)({
        kind: 'row',
        model,
        id,
        raw,
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

/** A scope entry whose row never landed is a torn commit tail: detach it with a counter. */
const detachRowlessScopeEntries = () => {
  const storage = (0, _configure.getDbRuntimeConfig)().storage;
  const scopePrefix = (0, _serialize.compositeStorageKey)((0, _configure.getStoragePrefix)(), 'scope');
  const models = new Set();
  for (const key of storage.keys(scopePrefix)) {
    const model = (0, _serialize.parseCompositeKey)(key.slice(scopePrefix.length))?.[0];
    if (model !== undefined && hasApplyTarget(model)) models.add(model);
  }
  for (const model of models) {
    const target = (0, _applyTargetRegistry.getApplyTarget)(model);
    for (const scopeKey of target.readAllScopeKeys()) {
      const missing = target.readScopeEntries(scopeKey).map(entry => entry.id).filter(id => target.readRow(id) === undefined);
      if (missing.length === 0) continue;
      (0, _diagnostics.noteDataLoss)('fsck-scope-detach', model, missing.length);
      (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
        kind: 'scope-delta',
        model,
        scopeKey,
        append: [],
        detach: missing
      }]));
    }
  }
};

/** A quarantined row that the current codecs admit again returns to its model and drops its ticket. */
const restoreReadmittedRows = () => {
  const restored = (0, _quarantine.takeQuarantineEntries)(entry => {
    if (entry.kind !== 'row' || entry.reason !== 'plan-row-rejected' || !hasApplyTarget(entry.model)) return false;
    try {
      return (0, _applyTargetRegistry.getApplyTarget)(entry.model).prepareUpsert(entry.raw, undefined, undefined, undefined, undefined, undefined) !== null;
    } catch {
      return false;
    }
  });
  for (const entry of restored) {
    (0, _configure.getApplyRuntime)().commit((0, _commitEnvelope.createCommitEnvelope)([{
      kind: 'upsert',
      model: entry.model,
      rows: [entry.raw]
    }]));
  }
};

/** Run every boot integrity check once, after hydrate and before the first render that reads a model. */
const runBootFsck = () => {
  closeCrashedRequests();
  quarantineOrphanTempRows();
  detachRowlessScopeEntries();
  restoreReadmittedRows();
};
exports.runBootFsck = runBootFsck;
//# sourceMappingURL=bootFsck.js.map