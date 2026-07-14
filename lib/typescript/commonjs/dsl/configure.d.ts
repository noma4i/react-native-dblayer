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
export declare const setAccountPartition: (nextAccountId: string | null) => void;
export declare const getDbRuntimeConfig: () => RuntimeConfig;
export declare const getAccountPartitionPrefix: () => string;
export {};
//# sourceMappingURL=configure.d.ts.map