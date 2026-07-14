import type { StoragePlane } from '../planes/storagePlane';
export type CheckpointTarget = {
    persistEntries(): Array<{
        key: string;
        value: string | null;
    }>;
};
export type CheckpointScheduler = {
    /** Note one applied plan touching these models; schedules (or forces) a snapshot flush. */
    notePlan(models: ReadonlyArray<string>, epoch: number): void;
    /**
     * Flush pending model snapshots, their applied-epoch markers and the checkpoint meta in ONE
     * ordered storage batch. Meta and applied markers come AFTER the snapshots they describe, so a
     * torn batch can never claim coverage for data that was not written.
     */
    flushNow(): void;
    /** Highest epoch covered by a completed flush - the journal prune gate. */
    flushedEpoch(): number;
    pendingPlans(): number;
    cancel(): void;
};
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
}) => CheckpointScheduler;
//# sourceMappingURL=checkpoint.d.ts.map