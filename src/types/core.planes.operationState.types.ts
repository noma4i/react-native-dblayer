export type OperationStatus = 'pending' | 'committed' | 'rolledback' | 'failed';
export type OperationIntent = 'insert' | 'patch' | 'destroy';
export type OperationRecord = {
  operationId: string;
  /** Stable declaration kind for a detached operation. */
  kind?: string;
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
  /** JSON-round-tripped input retained for durable retry of a failed optimistic insert. */
  failedInput?: unknown;
  createdAt: number;
};

export type OperationState = {
  begin(operation: Omit<OperationRecord, 'status'>, options?: { persist?: boolean }): void;
  /** Terminal status is immutable; repeated close calls are idempotent no-ops. Pass `{ persist: false }` to defer the ledger write onto a caller-owned `apply(..., { extraEntries })` batch. */
  close(operationId: string, status: Exclude<OperationStatus, 'pending'>, options?: { persist?: boolean }): void;
  get(operationId: string): OperationRecord | undefined;
  /** True when a retained `once` key or exact operation id already committed. */
  hasCommitted(idempotencyKey: string): boolean;
  /** True while an idempotency key has a pending operation - blocks double-taps. */
  hasPending(idempotencyKey: string): boolean;
  pending(): OperationRecord[];
  /** Open (pending or failed) insert-intent operations of one model - the correlation candidate pool. */
  openInsertsFor(model: string): OperationRecord[];
  /** Pending operations touching one model row (rowIds falling back to tempIds), in creation order. */
  pendingForRow(model: string, rowId: string): OperationRecord[];
  /** Failed operations touching one model row (rowIds union tempIds). */
  failedForRow(model: string, rowId: string): OperationRecord[];
  /** Most recent retained failed operation for one model row. */
  failedFor(model: string, rowId: string): OperationRecord | undefined;
  /** Remove one retained failed operation after retry, discard, or reconciliation. */
  clearFailed(operationId: string): void;
  /** Re-open a retained failed operation for durable retry. */
  reopen(operationId: string): OperationRecord | undefined;
  /** Remove any operation after an explicit discard or failed atomic start. Pass `{ persist: false }` to defer the ledger write onto a caller-owned `apply(..., { extraEntries })` batch. */
  remove(operationId: string, options?: { persist?: boolean }): void;
  /** Pending records loaded by hydrate; only these are crash orphans during boot reconciliation. */
  hydratedPending(): OperationRecord[];
  /** Consume hydrated pending records matching one boot reconciler exactly once. */
  takeHydratedPending(matches: (record: OperationRecord) => boolean): OperationRecord[];
  prune(): number;
  /** Union of fields owned by still-pending optimistic patch ops on one model row (empty when none). */
  ownedFields(model: string, rowId: string, excludeOpId?: string): ReadonlySet<string>;
  /** The value the latest still-pending patch op (excluding `excludeOpId`) wrote for one field of one model row, or `{ found: false }` when no other pending patch owns it. */
  latestPendingValue(model: string, rowId: string, field: string, excludeOpId?: string): { found: boolean; value: unknown };
  persistEntries(): Array<{ key: string; value: string | null }>;
  /** Hydrates the single ledger blob; malformed data is cold-reset because orphan temp-row reconciliation is the contract fallback. */
  hydrate(): void;
  reset(): void;
};
