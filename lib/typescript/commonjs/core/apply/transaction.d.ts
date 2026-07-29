import type { ApplyRuntime, ApplyTarget, CheckpointScheduler, CommitBus, CommitEnvelope, OperationTransition, StoragePlane, WriteOp } from '../../types';
/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale target so recreated runtimes can reuse stable model ids. Relation, GC, ingest, invalidation, and maintenance registries follow this same generation rule.
 */
export declare const registerApplyTarget: (model: string, target: ApplyTarget) => (() => void);
export declare const getApplyTarget: (model: string) => ApplyTarget;
export declare const getApplyTargets: () => Array<[string, ApplyTarget]>;
/**
 * Compile raw model intents into one complete callback-free plan before WAL. Entity work stays
 * ahead of scope membership so a reader cannot observe a membership pointing at a missing row.
 */
export declare const createCommitEnvelope: (ops: WriteOp[], explicitOperationTransitions?: readonly OperationTransition[]) => CommitEnvelope;
export declare const createApplyRuntime: (options: {
    storage: StoragePlane;
    prefix: () => string;
    bus: CommitBus;
    checkpoint?: CheckpointScheduler;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map