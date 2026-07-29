import type { CommitBatch } from './core.apply.commitBus.types';
import type { JournalOp } from './core.apply.journal.types';
import type { WriteOrigin } from './core.writePolicies.types';
import type { StoredRow } from './core.relations.types';
import type { OperationTransition } from './core.planes.operationState.types';

declare const commitEnvelopeBrand: unique symbol;

/** Complete write plan accepted by the sole runtime write entry point. */
export type CommitEnvelope = {
  schemaVersion: 1;
  txId: string;
  epoch: number;
  entityOps: JournalOp[];
  scopeOps: JournalOp[];
  operationEntries: Array<{ key: string; value: string | null }>;
  operationTransitions: OperationTransition[];
  readonly [commitEnvelopeBrand]: true;
};

/** Pure preview of one row write after normalization, ownership overlay, and write-policy evaluation. */
export type PreparedRowWrite = { row: StoredRow; changedFields: string[] | null };

/**
 * Model-owned application target. Planning methods are pure; `put`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to checkpoint flushes (or, on bare runtimes, to the immediate batch).
 */
export type ApplyTarget = {
  readRow(id: string): Record<string, unknown> | undefined;
  readAllRows(): Array<Record<string, unknown>>;
  /** Mechanical read of the persisted membership entries (id + final order key); never computes order. */
  readScopeEntries(scopeKey: string): Array<{ id: string; orderKey: string }>;
  /**
   * PLANNING-ONLY: compute final order keys for these ids in this scope (sort-aware for
   * field/comparator scopes, tail keys for server order). `readRow` sees plan-overlay rows.
   */
  planScopePlacement(scopeKey: string, ids: readonly string[], readRow: (model: string, id: string) => Record<string, unknown> | undefined): Array<{ id: string; orderKey: string }>;
  readScopeOrderRevision(scopeKey: string): number;
  readScopeGeneration(scopeKey: string): number;
  scopeOrderAffected(scopeKey: string, id: string, fields: string[] | null): boolean;
  scopeSortMeta(scopeKey: string): { kind: 'server-order' } | { kind: 'field'; field: string; dir: 'asc' | 'desc' } | { kind: 'comparator' };
  readAllScopeKeys(): string[];
  prepareUpsert(
    row: unknown,
    previous: StoredRow | undefined,
    origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>,
    mergeBase?: StoredRow,
    operationId?: string
  ): PreparedRowWrite | null;
  preparePatch(id: string, patch: Record<string, unknown>, previous: StoredRow | undefined, operationId?: string): PreparedRowWrite | null;
  put(rows: StoredRow[]): Array<{ id: string; changedFields: string[] | null }>;
  destroy(ids: string[], tombstone?: boolean): string[];
  scope(scopeKey: string, next: unknown): void;
  scopeDelta(scopeKey: string, delta: { append: Array<{ id: string; orderKey: string; edge?: Record<string, unknown> }>; detach: string[] }): void;
  reactiveScopes?(ids: string[]): string[];
  persistEntries(): Array<{ key: string; value: string | null }>;
  /** Clears the dirty markers captured by the last persistEntries; called only after a successful storage write. */
  ackPersist(): void;
};

export type ApplyRuntime = {
  /**
   * Apply one callback-free plan. All normalization, write policies, relation callbacks, cascade
   * discovery, and storage-entry producers have already completed before the pending WAL write.
   */
  commit(envelope: CommitEnvelope): CommitBatch;
  /**
   * Startup recovery: idempotently re-apply journal records not yet covered by each model's
   * persisted applied-epoch marker (survives torn checkpoint batches - the marker sits AFTER its
   * snapshot in the flush order); returns replayed record count.
   */
  replay(): number;
  currentEpoch(): number;
};
