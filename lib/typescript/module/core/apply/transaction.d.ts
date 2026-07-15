import type { CommitBatch, CommitBus } from './commitBus';
import type { CheckpointScheduler } from './checkpoint';
import type { JournalOp } from './journal';
import type { StoragePlane } from '../planes/storagePlane';
/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to checkpoint flushes (or, on bare runtimes, to the immediate batch).
 */
export type ApplyTarget = {
    upsert(rows: unknown[], origin?: 'event' | 'replace'): Array<{
        id: string;
        changedFields: string[] | null;
    }>;
    patch(id: string, patch: Record<string, unknown>): {
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
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
};
export type ApplyRuntime = {
    /** Apply one plan: WAL journal record -> in-memory apply -> journal commit mark -> one publish. */
    apply(ops: JournalOp[]): CommitBatch;
    /**
     * Startup recovery: idempotently re-apply journal records not yet covered by each model's
     * persisted applied-epoch marker (survives torn checkpoint batches - the marker sits AFTER its
     * snapshot in the flush order); returns replayed record count.
     */
    replay(): number;
    currentEpoch(): number;
};
/** Register one model-owned application target for v6 plans. */
export declare const registerApplyTarget: (model: string, target: ApplyTarget) => (() => void);
export declare const getApplyTarget: (model: string) => ApplyTarget;
export declare const createApplyRuntime: (options: {
    storage: StoragePlane;
    prefix: () => string;
    bus: CommitBus;
    checkpoint?: CheckpointScheduler;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map