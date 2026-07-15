import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTransport } from '../types';
import { type StoragePlane } from '../core/planes/storagePlane';
import { type ApplyRuntime } from '../core/apply/transaction';
import { type OperationState } from '../core/planes/operationState';
export interface DbDefaults {
    staleTime?: number;
    emptyStaleTime?: number;
    gcTime?: number;
    pageSize?: number;
    /** Checkpoint flush tuning: snapshots leave the hot path and batch here. */
    persistence?: {
        checkpointDelayMs?: number;
        maxPendingPlans?: number;
    };
    onSyncError?: (error: Error, ctx: {
        source: string;
        model?: string;
        scope?: unknown;
    }) => void;
}
type RuntimeConfig = {
    transport: DbTransport;
    storage: StoragePlane;
    queryClient?: QueryClient;
    logger?: DbLogger;
    defaults?: DbDefaults;
};
/** Configure v6 runtime seams and defaults. */
export declare const configureDb: (options: Omit<RuntimeConfig, "storage"> & {
    storage?: StoragePlane;
}) => void;
export declare const getDbRuntimeConfig: () => RuntimeConfig;
export declare const getStoragePrefix: () => string;
export declare const getCommitBus: () => {
    subscribe: (notify: () => void, deps?: ReadonlyArray<import("../core/apply/commitBus").Dependency>) => import("../core/apply/commitBus").CommitSubscription;
    publish: (batch: import("../core/apply/commitBus").CommitBatch) => void;
    publishAll: () => void;
    subscriberCount: () => number;
};
/** App-owned TanStack QueryClient handed to configureDb; undefined until configured. */
export declare const getDbQueryClient: () => QueryClient | undefined;
/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 * Persistence is WAL + checkpoint: plans write only their journal record; model snapshots flush
 * through the checkpoint scheduler off the hot path.
 */
export declare const getApplyRuntime: () => ApplyRuntime;
/**
 * Force a checkpoint flush NOW - pending model snapshots hit storage in one batch. The host app
 * must call this on background/inactive and before logout teardown.
 */
export declare const flushPersistence: () => void;
/** Persist plane mutations made by maintenance outside an apply-plan epoch. */
export declare const noteMaintenancePersistence: (models: ReadonlyArray<string>) => void;
/**
 * Idempotently re-apply journal records not yet covered by each model's persisted applied-epoch
 * marker. The host app must call this ONCE at startup, after configureDb and after every model
 * module has been imported (apply targets registered) - records touching unregistered models throw.
 * Returns the number of replayed records.
 */
export declare const replayJournal: () => number;
/**
 * Remove storage keys outside the library namespace - startup housekeeping that clears pre-v6
 * leftovers from the dedicated storage instance. Idempotent: a second run finds nothing.
 */
export declare const purgeForeignStorageKeys: () => number;
/** Internal: kill-switch discards pending snapshots (storage is being wiped anyway). */
export declare const cancelPersistence: () => void;
/** Internal: discard per-runtime WAL/checkpoint caches after storage has been wiped. */
export declare const resetPersistenceRuntime: () => void;
/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export declare const getOperationState: () => OperationState;
export {};
//# sourceMappingURL=configure.d.ts.map