import type { CommitBatch, CommitBus } from './commitBus';
import type { CheckpointScheduler } from './checkpoint';
import type { JournalOp } from './journal';
import type { StoragePlane } from '../planes/storagePlane';
import type { WriteOrigin } from '../../dsl/defineModel';
/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to checkpoint flushes (or, on bare runtimes, to the immediate batch).
 */
export type ApplyTarget = {
    readRow(id: string): Record<string, unknown> | undefined;
    readAllRows(): Array<Record<string, unknown>>;
    readScopeOrder(scopeKey: string): string[];
    /** Returns scope entries in visible order with their sparse scope-index order values. */
    readScopeEntries(scopeKey: string): Array<{
        id: string;
        order: number;
    }>;
    readScopeOrderRevision(scopeKey: string): number;
    scopeOrderAffected(scopeKey: string, id: string, fields: string[] | null): boolean;
    scopeSortMeta(scopeKey: string): {
        kind: 'server-order';
    } | {
        kind: 'field';
        field: string;
        dir: 'asc' | 'desc';
    } | {
        kind: 'comparator';
    };
    readAllScopeKeys(): string[];
    upsert(rows: unknown[], origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: Record<string, unknown>, operationId?: string): Array<{
        id: string;
        changedFields: string[] | null;
    }>;
    patch(id: string, patch: Record<string, unknown>, operationId?: string): {
        id: string;
        changedFields: string[] | null;
    } | null;
    destroy(ids: string[], tombstone?: boolean): string[];
    counter(id: string, field: string, delta: number, next?: number): boolean;
    counterValue(id: string, field: string): number | null;
    scope(scopeKey: string, next: unknown): void;
    scopeDelta(scopeKey: string, delta: {
        append: Array<{
            id: string;
            edge?: Record<string, unknown>;
            order?: number;
        }>;
        detach: string[];
    }): void;
    reactiveScopes?(ids: string[]): string[];
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
    /** Clears the dirty markers captured by the last persistEntries; called only after a successful storage write. */
    ackPersist(): void;
};
export type ApplyRuntime = {
    /**
     * Apply one plan: journal stores raw intent; effects derive inside the transaction from accepted
     * effective rows, so replay re-derives them.
     *
     * @note Honesty contract, not full STM: a partial in-memory commit is possible ONLY when a
     * consumer callback throws mid-plan (a write-group merge/accept predicate, a relation callback).
     * The WAL record for that epoch stays `pending` (never marked `committed`) - replay deterministically
     * re-applies it from scratch on the next boot, so persisted state never diverges from the journal.
     * On throw: `noteApplyFailure()` + `getDbLogger().error('apply failed', ...)` +
     * `defaults.onSyncError({source:'apply'})` fire, then the exception rethrows to the caller (mutation's
     * rollback path, ingest's `reportModelIngestError`, or replay's own boot-failure surface).
     */
    apply(ops: JournalOp[]): CommitBatch;
    /**
     * Startup recovery: idempotently re-apply journal records not yet covered by each model's
     * persisted applied-epoch marker (survives torn checkpoint batches - the marker sits AFTER its
     * snapshot in the flush order); returns replayed record count.
     */
    replay(): number;
    currentEpoch(): number;
};
/** Register one model-owned application target for model application plans. */
export declare const registerApplyTarget: (model: string, target: ApplyTarget) => (() => void);
export declare const getApplyTarget: (model: string) => ApplyTarget;
export declare const createApplyRuntime: (options: {
    storage: StoragePlane;
    prefix: () => string;
    bus: CommitBus;
    checkpoint?: CheckpointScheduler;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map