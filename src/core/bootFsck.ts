import type { OperationTransition, WriteOp } from '../types';
import { getApplyRuntime, getDbRuntimeConfig, getOperationState, getStoragePrefix } from '../dsl/configure';
import { isTempRowProtectedByModel } from '../dsl/maintenanceRegistry';
import { createCommitEnvelope } from './apply/commitEnvelope';
import { getApplyTarget } from './apply/applyTargetRegistry';
import { putQuarantine, takeQuarantineEntries } from './quarantine';
import { planRequestFailureRollback } from './requestRollback';
import { compositeKey, compositeStorageKey, parseCompositeKey } from './serialize';
import { isTempId } from '../utils/generateTempId';

/**
 * THE boot integrity pass. The delta log makes every commit durable and atomic, so no torn
 * row/membership shape exists to repair; what remains is operation truth: a crashed pending
 * request closes exactly like a runtime transport failure, an ownerless temp row is quarantined,
 * and a quarantined row that the current codecs accept again is restored.
 */

const hasApplyTarget = (model: string): boolean => {
  try {
    getApplyTarget(model);
    return true;
  } catch {
    return false;
  }
};

/** A kill mid-mutation closes exactly like a runtime transport failure: THE shared rollback planner, field-level for patches, retryable always. */
const closeCrashedRequests = (): void => {
  const operations = getOperationState();
  const crashedRequests = operations.takeHydratedPending(operation => operation.actionMode === 'request');
  if (crashedRequests.length === 0) return;
  const recoveryOps: WriteOp[] = [];
  const recoveryTransitions: OperationTransition[] = [];
  for (const operation of crashedRequests) {
    const planned = planRequestFailureRollback(
      operation,
      id => (hasApplyTarget(operation.model) ? getApplyTarget(operation.model).readRow(id) : undefined),
      (row, memberships) => [
        { kind: 'upsert', model: operation.model, rows: [row], origin: 'replace' },
        ...memberships.map(membership => ({
          kind: 'scope-delta' as const,
          model: operation.model,
          scopeKey: membership.scopeKey,
          append: [{ id: membership.id, orderKey: membership.orderKey }],
          detach: [membership.id]
        }))
      ]
    );
    recoveryOps.push(...planned.ops);
    recoveryTransitions.push(planned.transition);
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
  restoreReadmittedRows();
};
