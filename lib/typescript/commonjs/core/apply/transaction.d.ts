import type { ApplyRuntime, CommitBus, StoragePlane } from '../../types';
/**
 * One apply runtime per configured database: every model shares the same epoch counter and commit
 * bus, so one plan touching several models applies and persists as one transaction.
 *
 * Every commit is durable before it returns. The operation ledger (the user's unacked writes) and
 * the commit's cache delta (one atomic `delta:<seq>` key carrying rows AND scope changes) are both
 * written synchronously - a kill at any later point finds the commit on disk, and the row/membership
 * pair can never tear. Model snapshots coalesce per tick as COMPACTION: the flush writes each dirty
 * model's snapshot, advances its `snapseq`, and deletes the deltas the snapshots now cover.
 */
export declare const createApplyRuntime: (options: {
    storage: StoragePlane;
    prefix: () => string;
    bus: CommitBus;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map