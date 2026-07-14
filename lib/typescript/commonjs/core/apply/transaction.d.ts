import type { CommitBatch, CommitBus } from './commitBus';
import type { JournalOp } from './journal';
import type { StoragePlane } from '../planes/storagePlane';
/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to the transaction's single durable storage batch.
 */
export type ApplyTarget = {
    upsert(rows: unknown[]): Array<{
        id: string;
        changedFields: string[] | null;
    }>;
    patch(id: string, patch: Record<string, unknown>): {
        id: string;
        changedFields: string[] | null;
    } | null;
    destroy(ids: string[]): string[];
    counter(id: string, field: string, delta: number): boolean;
    scope(scopeKey: string, next: unknown): void;
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
};
export type ApplyRuntime = {
    /** Apply one plan: journal pending -> in-memory apply -> single durable batch -> one commit publish. */
    apply(ops: JournalOp[]): CommitBatch;
    /** Replay incomplete epochs on startup (torn-write recovery); returns replayed epoch count. */
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
    setFreshness?: (key: string, value: unknown) => void;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map