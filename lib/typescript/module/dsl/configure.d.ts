import { QueryClient } from '@tanstack/react-query';
import type { ApplyRuntime, CommitBus, ConfigureDbOptions, OperationState, RuntimeConfig } from '../types';
/**
 * Configure the injected runtime seams (transport, storage, logger) and package-wide
 * defaults. Must be called once before any model, query, or mutation runs; calling it again advances the
 * runtime generation, discards cached apply/operation runtimes, and re-applies transport/logger.
 *
 * Call this before rendering `DbProvider`; the provider owns the subsequent `bootDb` data lifecycle.
 *
 * @param options.transport GraphQL transport (`query`/`mutation`) used by `defineQuery`/`defineMutation`.
 * @param options.storage Synchronous key/value seam for persistence; defaults to `mmkvStoragePlane()`.
 * @param options.logger Package logger seam; optional, defaults to the built-in logger.
 * @param options.defaults Package-wide freshness/pagination/error-observation defaults (see `DbDefaults`).
 */
export declare const configureDb: (options: ConfigureDbOptions) => void;
export declare const getDbRuntimeConfig: () => RuntimeConfig;
/**
 * Internal: the package-owned TanStack QueryClient behind every `defineQuery`/`defineFetch`
 * freshness decision. Never exposed to consumers - the library stays the only QueryClient owner.
 * Query retry policy maps our `DbRetryPolicy` formula onto react-query's retry/retryDelay pair;
 * `networkMode: 'online'` pauses in-flight fetches while the coordinator reports offline.
 */
export declare const getDbQueryClient: () => QueryClient;
/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
export declare const isDbConfigured: () => boolean;
export declare const getStoragePrefix: () => string;
/** Internal: consumer-owned cache version used by the persistence manifest compatibility gate. */
export declare const getPersistenceDataVersion: () => string | null;
/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export declare const getRuntimeGeneration: () => number;
/** Internal: establish a new generation before the reset fence tears down the old runtime. */
export declare const advanceRuntimeGeneration: () => void;
export declare const getCommitBus: () => CommitBus;
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
 * `bootDb` calls this before garbage collection and foreign-key cleanup and surfaces the result as
 * `{ replayed }`.
 *
 * @returns The number of journal records replayed.
 */
export declare const replayJournal: () => number;
/**
 * Remove storage keys outside the library namespace during startup housekeeping for the dedicated
 * storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb()` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
export declare const purgeForeignStorageKeys: () => number;
/** Internal: discard per-runtime WAL/checkpoint caches after storage has been wiped. */
export declare const resetPersistenceRuntime: () => void;
/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export declare const getOperationState: () => OperationState;
//# sourceMappingURL=configure.d.ts.map