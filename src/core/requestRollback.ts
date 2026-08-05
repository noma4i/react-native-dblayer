import type { OperationRecord, OperationTransition, WriteOp } from '../types';
import { getOperationState } from '../dsl/configure';
import { stableSerialize } from './serialize';

/**
 * THE rollback planner for a failed or crashed request operation - the runtime transport-failure
 * path and the boot fsck share it, so a kill mid-mutation ends exactly like a runtime failure.
 * insert: the temp row stays and the operation is retryable. patch: field-level rollback - only
 * the fields the operation patched, only while the row still holds the operation's own value and
 * no other pending operation owns the field; fields landed after the operation started survive.
 * destroy: restore the pre-destroy snapshot and memberships.
 */
export const planRequestFailureRollback = (
  operation: OperationRecord,
  readRow: (id: string) => Record<string, unknown> | undefined,
  planRestore: (row: Record<string, unknown>, memberships: Array<{ id: string; scopeKey: string; orderKey: string }>) => WriteOp[]
): { ops: WriteOp[]; transition: OperationTransition } => {
  const rollbackRow = operation.rollbackRow;
  const ops: WriteOp[] = [];
  if (operation.intent === 'patch' && rollbackRow !== undefined) {
    const rowId = operation.rowIds[0]!;
    const current = readRow(rowId);
    if (current) {
      const patch: Record<string, unknown> = {};
      const remove: string[] = [];
      for (const field of operation.patchedFields ?? []) {
        const latest = getOperationState().latestPendingValue(operation.model, rowId, field, operation.operationId);
        if (latest.found) {
          patch[field] = latest.value;
          continue;
        }
        if (!operation.patchedValues || stableSerialize(current[field]) !== stableSerialize(operation.patchedValues[field])) continue;
        if (Object.hasOwn(rollbackRow, field)) {
          patch[field] = rollbackRow[field];
          continue;
        }
        remove.push(field);
      }
      ops.push({ kind: 'patch', model: operation.model, id: rowId, patch, remove, operationId: operation.operationId });
    }
  } else if (operation.intent === 'destroy' && rollbackRow !== undefined && operation.rollbackMemberships !== undefined) {
    ops.push(...planRestore(rollbackRow, operation.rollbackMemberships));
  }
  const retryable = operation.tempIds.length > 0 || rollbackRow !== undefined;
  return { ops, transition: { kind: 'close', operationId: operation.operationId, status: retryable ? 'failed' : 'rolledback' } };
};
