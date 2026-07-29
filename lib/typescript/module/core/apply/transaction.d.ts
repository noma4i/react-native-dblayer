import type { ApplyRuntime, CheckpointScheduler, CommitBus, StoragePlane } from '../../types';
export declare const createApplyRuntime: (options: {
    storage: StoragePlane;
    prefix: () => string;
    bus: CommitBus;
    checkpoint?: CheckpointScheduler;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map