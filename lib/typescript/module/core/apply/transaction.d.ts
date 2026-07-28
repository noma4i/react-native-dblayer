import type { ApplyRuntime, ApplyTarget, CheckpointScheduler, CommitBus, CommitEnvelope, JournalOp, StoragePlane } from '../../types';
/**
 * Build one opaque-to-consumers commit plan from the model-owned operation planners.
 * Entity work is always applied before scope membership, so a reader can never observe a scope
 * entry that points at a missing row.
 */
export declare const createCommitEnvelope: (ops: JournalOp[], extraEntries?: () => Array<{
    key: string;
    value: string | null;
}>) => CommitEnvelope;
/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale target so recreated runtimes can reuse stable model ids. Relation, GC, ingest, invalidation, and maintenance registries follow this same generation rule.
 */
export declare const registerApplyTarget: (model: string, target: ApplyTarget) => (() => void);
export declare const getApplyTarget: (model: string) => ApplyTarget;
export declare const getApplyTargets: () => Array<[string, ApplyTarget]>;
export declare const createApplyRuntime: (options: {
    storage: StoragePlane;
    prefix: () => string;
    bus: CommitBus;
    checkpoint?: CheckpointScheduler;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map