import type { StoragePlane } from './storagePlane';
export type OperationStatus = 'pending' | 'committed' | 'rolledback';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = {
    operationId: string;
    model: string;
    tempIds: string[];
    rowIds?: string[];
    intent: OperationIntent;
    status: OperationStatus;
    idempotencyKey?: string;
    createdAt: number;
};
export type OperationState = {
    begin(operation: Omit<OperationRecord, 'status'>): void;
    close(operationId: string, status: Exclude<OperationStatus, 'pending'>): void;
    get(operationId: string): OperationRecord | undefined;
    /** True when an idempotency key already committed - callers must skip re-applying. */
    hasCommitted(idempotencyKey: string): boolean;
    /** True while an idempotency key has a pending operation - blocks double-taps. */
    hasPending(idempotencyKey: string): boolean;
    pending(): OperationRecord[];
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