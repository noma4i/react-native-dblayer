import type { ApplyRuntime, CommitBus, StoragePlane } from '../../types';
/**
 * One apply runtime per configured database: every model shares the same epoch counter and commit
 * bus, so one plan touching several models applies and persists as one transaction.
 *
 * Persistence splits by data class. The operation ledger (the user's unacked writes) is written
 * SYNCHRONOUSLY inside the commit - a kill right after a send still finds the operation and its
 * domain input on disk. Model cache snapshots (rows, scopes) coalesce per tick: back-to-back
 * commits in one tick encode each dirty model once, and a kill inside that window costs only
 * refetchable cache that the ledger can rebuild.
 */
export declare const createApplyRuntime: (options: {
    storage: StoragePlane;
    prefix: () => string;
    bus: CommitBus;
}) => ApplyRuntime;
//# sourceMappingURL=transaction.d.ts.map