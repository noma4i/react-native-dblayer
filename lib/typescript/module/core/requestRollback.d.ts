import type { OperationRecord, OperationTransition, WriteOp } from '../types';
/**
 * THE rollback planner for a failed or crashed request operation - the runtime transport-failure
 * path and the boot fsck share it, so a kill mid-mutation ends exactly like a runtime failure.
 * insert: the temp row stays and the operation is retryable. patch: field-level rollback - only
 * the fields the operation patched, only while the row still holds the operation's own value and
 * no other pending operation owns the field; fields landed after the operation started survive.
 * destroy: restore the pre-destroy snapshot and memberships.
 */
export declare const planRequestFailureRollback: (operation: OperationRecord, readRow: (id: string) => Record<string, unknown> | undefined, planRestore: (row: Record<string, unknown>, memberships: Array<{
    id: string;
    scopeKey: string;
    orderKey: string;
}>) => WriteOp[]) => {
    ops: WriteOp[];
    transition: OperationTransition;
};
//# sourceMappingURL=requestRollback.d.ts.map