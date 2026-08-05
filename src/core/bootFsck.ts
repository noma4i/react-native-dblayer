import type { OperationTransition, WriteOp } from '../types';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState, getStoragePrefix } from '../dsl/configure';
import { isTempRowProtectedByModel } from '../dsl/maintenanceRegistry';
import { createCommitEnvelope } from './apply/commitEnvelope';
import { getApplyTarget } from './apply/applyTargetRegistry';
import { noteDataLoss } from './diagnostics';
import { putQuarantine, takeQuarantineEntries } from './quarantine';
import { compositeKey, compositeStorageKey, parseCompositeKey } from './serialize';
import { isTempId } from '../utils/generateTempId';

/**
 * THE boot integrity pass. Persistence is immediate, so a crash can leave the namespace with a
 * partially-written commit; every check below repairs one partial-write shape without dropping
 * user data: a crashed pending request closes as retryable, an ownerless temp row is quarantined,
 * a scope entry without a row detaches with a counter, and a quarantined row that the current
 * codecs accept again is restored.
 */

const hasApplyTarget = (model: string): boolean => {
  try {
    getApplyTarget(model);
    return true;
  } catch {
    return false;
  }
};

/** A kill mid-mutation closes exactly like a runtime transport failure: the row rolls back, the operation stays retryable, an unsent insert is never destroyed. */
const closeCrashedRequests = (): void => {
  const operations = getOperationState();
  const crashedRequests = operations.takeHydratedPending(operation => operation.actionMode === 'request');
  if (crashedRequests.length === 0) return;
  const recoveryOps: WriteOp[] = [];
  const recoveryTransitions: OperationTransition[] = [];
  for (const operation of crashedRequests) {
    const rollbackRow = operation.rollbackRow;
    const rollbackMemberships = operation.rollbackMemberships;
    if (rollbackRow !== undefined && rollbackMemberships !== undefined) {
      recoveryOps.push({ kind: 'upsert', model: operation.model, rows: [rollbackRow], origin: 'replace' });
      for (const membership of rollbackMemberships) {
        recoveryOps.push({
          kind: 'scope-delta',
          model: operation.model,
          scopeKey: membership.scopeKey,
          append: [{ id: membership.id, orderKey: membership.orderKey }],
          detach: [membership.id]
        });
      }
    }
    const retryable = operation.tempIds.length > 0 || rollbackRow !== undefined;
    recoveryTransitions.push({ kind: 'close', operationId: operation.operationId, status: retryable ? 'failed' : 'rolledback' });
  }
  getApplyRuntime().commit(createCommitEnvelope(recoveryOps, recoveryTransitions));
};

/** An ownerless temp row leaves the store, but its payload is quarantined - never dropped. */
const quarantineOrphanTempRows = (): void => {
  const storage = getDbRuntimeConfig().storage;
  const operations = getOperationState();
  const rowPrefix = compositeStorageKey(getStoragePrefix(), 'row');
  const candidates = new Map<string, Set<string>>();
  for (const key of storage.keys(rowPrefix)) {
    const parts = parseCompositeKey(key.slice(rowPrefix.length));
    if (parts?.length !== 2) continue;
    const [model, id] = parts as [string, string];
    if (!isTempId(id)) continue;
    const ids = candidates.get(model) ?? new Set<string>();
    ids.add(id);
    candidates.set(model, ids);
  }
  const openTempIds = new Set(operations.open().flatMap(operation => operation.tempIds.map(id => compositeKey(operation.model, id))));
  for (const [model, ids] of candidates) {
    const orphanIds = [...ids].filter(id => !openTempIds.has(compositeKey(model, id)) && !operations.failedFor(model, id) && !isTempRowProtectedByModel(model, id));
    if (orphanIds.length === 0 || !hasApplyTarget(model)) continue;
    for (const id of orphanIds) {
      const raw = storage.get(compositeStorageKey(getStoragePrefix(), 'row', model, id));
      if (raw !== undefined) putQuarantine({ kind: 'row', model, id, raw, reason: 'orphan-temp-row' });
    }
    getApplyRuntime().commit(createCommitEnvelope([{ kind: 'destroy', model, ids: orphanIds, tombstone: false }]));
  }
};

/** A scope entry whose row never landed is a torn commit tail: detach it with a counter. */
const detachRowlessScopeEntries = (): void => {
  const storage = getDbRuntimeConfig().storage;
  const scopePrefix = compositeStorageKey(getStoragePrefix(), 'scope');
  const models = new Set<string>();
  for (const key of storage.keys(scopePrefix)) {
    const model = parseCompositeKey(key.slice(scopePrefix.length))?.[0];
    if (model !== undefined && hasApplyTarget(model)) models.add(model);
  }
  for (const model of models) {
    const target = getApplyTarget(model);
    for (const scopeKey of target.readAllScopeKeys()) {
      const missing = target
        .readScopeEntries(scopeKey)
        .map(entry => entry.id)
        .filter(id => target.readRow(id) === undefined);
      if (missing.length === 0) continue;
      noteDataLoss('fsck-scope-detach', model, missing.length);
      getApplyRuntime().commit(createCommitEnvelope([{ kind: 'scope-delta', model, scopeKey, append: [], detach: missing }]));
    }
  }
};

/** A quarantined row that the current codecs admit again returns to its model and drops its ticket. */
const restoreReadmittedRows = (): void => {
  const restored = takeQuarantineEntries(entry => {
    if (entry.kind !== 'row' || entry.reason !== 'plan-row-rejected' || !hasApplyTarget(entry.model)) return false;
    try {
      return getApplyTarget(entry.model).prepareUpsert(entry.raw, undefined, undefined, undefined, undefined, undefined) !== null;
    } catch {
      return false;
    }
  });
  for (const entry of restored) {
    getApplyRuntime().commit(createCommitEnvelope([{ kind: 'upsert', model: entry.model, rows: [entry.raw] }]));
  }
};

/** Run every boot integrity check once, after hydrate and before the first render that reads a model. */
export const runBootFsck = (): void => {
  closeCrashedRequests();
  quarantineOrphanTempRows();
  detachRowlessScopeEntries();
  restoreReadmittedRows();
};
