import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTrackSink, DbTransport } from '../types';
import { type StoragePlane } from '../core/planes/storagePlane';
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
export declare const getStoragePrefix: () => string;
export declare const getCommitBus: () => {
    subscribe: (notify: () => void, deps?: ReadonlyArray<import("../core/apply/commitBus").Dependency>) => import("../core/apply/commitBus").CommitSubscription;
    publish: (batch: import("../core/apply/commitBus").CommitBatch) => void;
    subscriberCount: () => number;
};
export {};
//# sourceMappingURL=configure.d.ts.map