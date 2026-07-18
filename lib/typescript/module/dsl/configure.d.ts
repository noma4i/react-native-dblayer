import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTransport } from '../types';
import { type StoragePlane } from '../core/planes/storagePlane';
import { type ApplyRuntime } from '../core/apply/transaction';
import { type OperationState } from '../core/planes/operationState';
export interface DbDefaults {
    /** Package-wide default `staleTime` (ms) for `defineQuery` results that omit their own. */
    staleTime?: number;
    /** Package-wide default `emptyStaleTime` (ms) for `defineQuery` results that omit their own. */
    emptyStaleTime?: number;
    /** Package-wide default TanStack Query cache `gcTime` (ms) for `defineQuery` results that omit their own. */
    gcTime?: number;
    /** Package-wide default window size for `ScopeHandle.useWindow` when its own `pageSize` is omitted. */
    pageSize?: number;
    /** Checkpoint flush tuning: snapshots leave the hot path and batch here. */
    persistence?: {
        checkpointDelayMs?: number;
        maxPendingPlans?: number;
    };
    /**
     * In-session garbage-collection trigger tuning. ON by default (`threshold: 500`,
     * `debounceMs: 1000`) - a burst of destroys/inserts crossing the pressure threshold schedules one
     * debounced `collectGarbage()` sweep. Set `false` to disable the trigger entirely; `bootDb`'s
     * startup sweep and manual `collectGarbage()` calls are unaffected either way.
     */
    inSessionGc?: false | {
        threshold?: number;
        debounceMs?: number;
    };
    /** Observes contained pipeline failures from `query`, `mutation`, and `ingest` without changing their control flow. */
    onSyncError?: (error: Error, ctx: {
        source: string;
        model?: string;
        scope?: unknown;
        key?: string;
        event?: string;
    }) => void;
}
type RuntimeConfig = {
    transport: DbTransport;
    storage: StoragePlane;
    queryClient?: QueryClient;
    logger?: DbLogger;
    defaults?: DbDefaults;
};
/**
 * Configure the injected runtime seams (transport, storage, query client, logger) and package-wide
 * defaults. Must be called once before any model, query, or mutation runs; calling it again advances the
 * runtime generation, discards cached apply/operation runtimes, and re-applies transport/logger.
 *
 * Most apps should call `bootDb(options)` instead: it wraps this call with the recommended
 * `replayJournal`/`collectGarbage`/`purgeForeignStorageKeys` startup sequence. `configureDb` stays
 * exported directly for callers with a different startup sequencing need.
 *
 * @param options.transport GraphQL transport (`query`/`mutation`) used by `defineQuery`/`defineMutation`.
 * @param options.storage Synchronous key/value seam for persistence; defaults to `mmkvStoragePlane()`.
 * @param options.queryClient TanStack Query client shared with `defineQuery`'s hooks; optional.
 * @param options.logger Package logger seam; optional, defaults to the built-in logger.
 * @param options.defaults Package-wide freshness/pagination/error-observation defaults (see `DbDefaults`).
 */
export declare const configureDb: (options: Omit<RuntimeConfig, "storage"> & {
    storage?: StoragePlane;
}) => void;
export declare const getDbRuntimeConfig: () => RuntimeConfig;
/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
export declare const isDbConfigured: () => boolean;
/** Internal: reports whether the current runtime completed journal replay. */
export declare const hasReplayedJournal: () => boolean;
export declare const getStoragePrefix: () => string;
/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export declare const getRuntimeGeneration: () => number;
/** Internal: establish a new generation before the reset fence tears down the old runtime. */
export declare const advanceRuntimeGeneration: () => void;
export declare const getCommitBus: () => {
    subscribe: (notify: () => void, deps?: ReadonlyArray<import("../core/apply/commitBus").Dependency>, onBatch?: (batch: import("../core/apply/commitBus").IncrementalCommitBatch | null) => void) => import("../core/apply/commitBus").CommitSubscription;
    subscribeIncremental: (notify: () => void, deps: ReadonlyArray<import("../core/apply/commitBus").Dependency>, onBatch: (batch: import("../core/apply/commitBus").IncrementalCommitBatch | null) => void) => import("../core/apply/commitBus").CommitSubscription;
    subscribeAll: (onBatch: (batch: import("../core/apply/commitBus").IncrementalCommitBatch) => void) => (() => void);
    activeDependencies: () => ReadonlyArray<import("../core/apply/commitBus").Dependency>;
    publish: (batch: import("../core/apply/commitBus").IncrementalCommitBatch) => void;
    publishAll: () => void;
    subscriberCount: () => number;
};
/**
 * App-owned TanStack QueryClient handed to configureDb; undefined until configured.
 *
 * @returns The configured TanStack QueryClient, or undefined if configureDb has not been called.
 */
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
 * must call this on background/inactive and before logout teardown. `suspendDb()` calls this for you
 * as part of the recommended background/teardown sequence.
 */
export declare const flushPersistence: () => void;
/** Persist plane mutations made by maintenance outside an apply-plan epoch. */
export declare const noteMaintenancePersistence: (models: ReadonlyArray<string>) => void;
/**
 * Idempotently re-apply journal records not yet covered by each model's persisted applied-epoch
 * marker. The host app must call this ONCE at startup, after configureDb and after every model
 * module has been imported (apply targets registered) - records touching unregistered models throw.
 * Returns the number of replayed records.
 *
 * Most apps should call `bootDb(options)` instead, which runs this in the recommended startup order
 * (`configureDb` -> `replayJournal` -> `collectGarbage` -> `purgeForeignStorageKeys`) and surfaces this
 * function's return value as `{ replayed }`.
 *
 * @returns The number of journal records replayed.
 */
export declare const replayJournal: () => number;
/**
 * Remove storage keys outside the library namespace - startup housekeeping that clears pre-v6
 * leftovers from the dedicated storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb(options)` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
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