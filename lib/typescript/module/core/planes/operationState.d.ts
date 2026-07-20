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
    createdAt: number;
};
export type OperationState = {
    begin(operation: Omit<OperationRecord, 'status'>): void;
    close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
    get(operationId: string): OperationRecord | undefined;
    /** True when a retained `once` key or exact operation id already committed. */
    hasCommitted(idempotencyKey: string): boolean;
    /** True while an idempotency key has a pending operation - blocks double-taps. */
    hasPending(idempotencyKey: string): boolean;
    pending(): OperationRecord[];
    /** Most recent retained failed operation for one model row. */
    failedFor(model: string, rowId: string): OperationRecord | undefined;
    /** Remove one retained failed operation after retry, discard, or reconciliation. */
    clearFailed(operationId: string): void;
    /** Pending records loaded by hydrate; only these are crash orphans during boot reconciliation. */
    hydratedPending(): OperationRecord[];
    prune(): number;
    /** Monotonic keyed sequence (e.g. an optimistic ordering floor per parent row); floor raises the base. */
    nextSequence(key: string, floor: number): number;
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
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