import type { StoragePlane, CheckpointScheduler, CheckpointTarget } from '../../types';
/**
 * Checkpoint side of the WAL pair: plans persist only their journal record on the hot path
 * (O(plan)); full model snapshots (O(model) serialization) leave the frame and flush here -
 * debounced, capped, or forced by the host app on background/logout via flushPersistence().
 */
export declare const createCheckpointScheduler: (options: {
    storage: StoragePlane;
    prefix: () => string;
    getTarget(model: string): CheckpointTarget;
    delayMs: number;
    maxPendingPlans: number;
    /** Extra storage entries appended to every flush batch (e.g. the operation ledger). */
    extraEntries?: () => Array<{
        key: string;
        value: string | null;
    }>;
}) => CheckpointScheduler;
//# sourceMappingURL=checkpoint.d.ts.map