import type { StoragePlane } from './storagePlane';
export type OperationStatus = 'pending' | 'committed' | 'rolledback' | 'failed';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = {
    operationId: string;
    model: string;
    tempIds: string[];
    rowIds?: string[];
    intent: OperationIntent;
    status: OperationStatus;
    idempotencyKey?: string;
    /** Retain a committed idempotency key until reset. Default operations guard only while pending. */
    once?: boolean;
    /** Top-level fields an optimistic method-patch owns while pending; its ledger record is created before the optimistic journal patch so that internal optimistic patches and rollbacks bypass overlay, while foreign writes keep the current value until the op closes. */
    patchedFields?: string[];
    /** The concrete field->value map an optimistic method-patch wrote; used to resolve a field to the latest still-pending patch on rollback. */
    patchedValues?: Record<string, unknown>;
    createdAt: number;
};
export type OperationState = {
    begin(operation: Omit<OperationRecord, 'status'>): void;
    /** Terminal status is immutable; repeated close calls are idempotent no-ops. */
    close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
    get(operationId: string): OperationRecord | undefined;
    /** True when a retained `once` key or exact operation id already committed. */
    hasCommitted(idempotencyKey: string): boolean;
    /** True while an idempotency key has a pending operation - blocks double-taps. */
    hasPending(idempotencyKey: string): boolean;
    pending(): OperationRecord[];
    /** Pending operations touching one model row (rowIds falling back to tempIds), in creation order. */
    pendingForRow(model: string, rowId: string): OperationRecord[];
    /** Failed operations touching one model row (rowIds union tempIds). */
    failedForRow(model: string, rowId: string): OperationRecord[];
    /** Most recent retained failed operation for one model row. */
    failedFor(model: string, rowId: string): OperationRecord | undefined;
    /** Remove one retained failed operation after retry, discard, or reconciliation. */
    clearFailed(operationId: string): void;
    /** Pending records loaded by hydrate; only these are crash orphans during boot reconciliation. */
    hydratedPending(): OperationRecord[];
    prune(): number;
    /** Union of fields owned by still-pending optimistic patch ops on one model row (empty when none). */
    ownedFields(model: string, rowId: string, excludeOpId?: string): ReadonlySet<string>;
    /** The value the latest still-pending patch op (excluding `excludeOpId`) wrote for one field of one model row, or `{ found: false }` when no other pending patch owns it. */
    latestPendingValue(model: string, rowId: string, field: string, excludeOpId?: string): {
        found: boolean;
        value: unknown;
    };
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    /** Hydrates the single ledger blob; malformed data is cold-reset because orphan temp-row reconciliation is the contract fallback. */
    hydrate(): void;
    reset(): void;
};
export declare const createOperationState: (options: {
    storage: StoragePlane;
    prefix: () => string;
    now: () => number;
    notify?: (record: OperationRecord) => void;
}) => OperationState;
//# sourceMappingURL=operationState.d.ts.map