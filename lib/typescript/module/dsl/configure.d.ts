import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTrackSink, DbTransport } from '../types';
import { type StoragePlane } from '../core/planes/storagePlane';
import { type ApplyRuntime } from '../core/apply/transaction';
import { type OperationState } from '../core/planes/operationState';
export interface DbDefaults {
    staleTime?: number;
    emptyStaleTime?: number;
    gcTime?: number;
    pageSize?: number;
    merge?: {
        dedupeWindowMs?: number;
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
    track?: DbTrackSink;
    defaults?: DbDefaults;
};
/** Configure v6 runtime seams and defaults. */
export declare const configureDb: (options: Omit<RuntimeConfig, "storage"> & {
    storage?: StoragePlane;
}) => void;
export declare const getDbRuntimeConfig: () => RuntimeConfig;
/** App-owned TanStack QueryClient handed to configureDb; undefined until configured. */
export declare const getDbQueryClient: () => QueryClient | undefined;
export declare const getStoragePrefix: () => string;
export declare const getCommitBus: () => {
    subscribe: (notify: () => void, deps?: ReadonlyArray<import("../core/apply/commitBus").Dependency>) => import("../core/apply/commitBus").CommitSubscription;
    publish: (batch: import("../core/apply/commitBus").CommitBatch) => void;
    publishAll: () => void;
    subscriberCount: () => number;
};
/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 */
export declare const getApplyRuntime: () => ApplyRuntime;
/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export declare const getOperationState: () => OperationState;
export {};
//# sourceMappingURL=configure.d.ts.map