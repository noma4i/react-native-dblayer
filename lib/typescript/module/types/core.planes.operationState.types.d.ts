export type OperationStatus = 'pending' | 'committed' | 'rolledback' | 'failed' | 'delivery_unknown';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = {
    operationId: string;
    /** Canonical model action identity. */
    actionKey: string;
    /** Model action mode that owns this operation. */
    actionMode: 'request' | 'durable';
    model: string;
    tempIds: string[];
    rowIds: string[];
    intent: OperationIntent;
    status: OperationStatus;
    idempotencyKey?: string;
    /** Retain a committed idempotency key until reset. Default operations guard only while pending. */
    once?: boolean;
    /** Top-level fields an optimistic method-patch owns while pending; its ledger record is created before the optimistic patch applies so that internal optimistic patches and rollbacks bypass overlay, while foreign writes keep the current value until the op closes. */
    patchedFields?: string[];
    /** The concrete field->value map an optimistic method-patch wrote; used to resolve a field to the latest still-pending patch on rollback. */
    patchedValues?: Record<string, unknown>;
    /** JSON-round-tripped domain input retained for request or durable action persistence. */
    input?: unknown;
    /** Exact pre-optimistic stored owner row for request update or destroy rollback. */
    rollbackRow?: Record<string, unknown>;
    /** Exact pre-optimistic owner membership snapshot for request update or destroy rollback. */
    rollbackMemberships?: Array<{
        id: string;
        scopeKey: string;
        orderKey: string;
    }>;
    createdAt: number;
};
/** Immutable operation-ledger change carried by a commit envelope. */
export type OperationTransition = {
    kind: 'begin';
    operation: Omit<OperationRecord, 'status'>;
} | {
    kind: 'close';
    operationId: string;
    status: Exclude<OperationStatus, 'pending'>;
} | {
    kind: 'remove';
    operationId: string;
    expectedStatus?: OperationStatus;
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
    /** Open (unresolved) operations: pending plus failed-but-retryable. The ONE protection root for TTL and replay orphan cleanup. */
    open(): OperationRecord[];
    /** Open (pending or failed) insert-intent operations of one model - the correlation candidate pool. */
    openInsertsFor(model: string): OperationRecord[];
    /** Row ids (temp and confirmed) held by open operations of one model - the same protection root projected for scope planning. */
    openRowIdsFor(model: string): ReadonlySet<string>;
    /** Pending operations touching one model row, in creation order. */
    pendingForRow(model: string, rowId: string): OperationRecord[];
    /** Failed operations touching one model row (rowIds union tempIds). */
    failedForRow(model: string, rowId: string): OperationRecord[];
    /** Unknown-delivery operations touching one model row. */
    deliveryUnknownForRow(model: string, rowId: string): OperationRecord[];
    /** Most recent retained failed operation for one model row. */
    failedFor(model: string, rowId: string): OperationRecord | undefined;
    /** Remove one retained failed operation after retry, discard, or reconciliation. */
    clearFailed(operationId: string): void;
    /** Re-open a retained failed operation for durable retry. */
    reopen(operationId: string): OperationRecord | undefined;
    /** Row buckets still held by at least one operation - a gauge, so a bucket left behind is visible. */
    residentRowBuckets(): number;
    /** Remove any operation after an explicit discard or failed atomic start. */
    remove(operationId: string): void;
    /** Pending records loaded by hydrate; only these are crash orphans during boot reconciliation. */
    hydratedPending(): OperationRecord[];
    /** Consume hydrated pending records matching one boot reconciler exactly once. */
    takeHydratedPending(matches: (record: OperationRecord) => boolean): OperationRecord[];
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
    /** Materialize durable entries for transitions without changing live ledger state. */
    prepareTransitions(transitions: readonly OperationTransition[]): Array<{
        key: string;
        value: string | null;
    }>;
    /** Apply already-durable transitions to live state and return records whose pending dependencies changed. */
    applyTransitions(transitions: readonly OperationTransition[]): OperationRecord[];
    /** Hydrates the single ledger blob; malformed data is cold-reset because orphan temp-row reconciliation is the contract fallback. */
    hydrate(): void;
    reset(): void;
};
/** Single persisted operation snapshot. Operations and retained once keys never diverge. */
export type PersistedOperationState = {
    recordVersion: 2;
    operations: Record<string, OperationRecord>;
    committedKeys: string[];
};
//# sourceMappingURL=core.planes.operationState.types.d.ts.map