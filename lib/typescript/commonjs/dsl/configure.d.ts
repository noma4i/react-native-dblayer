import { QueryClient } from '@tanstack/react-query';
import type { ApplyRuntime, CommitBus, ConfigureDbOptions, OperationState, RuntimeConfig } from '../types';
import { advanceRuntimeGeneration, getRuntimeGeneration } from '../utils/runtimeGeneration';
/**
 * Configure the injected runtime seams (transport, storage, logger) and package-wide
 * defaults. Must be called once before any model, query, or mutation runs; calling it again advances the
 * runtime generation, discards cached apply/operation runtimes, and re-applies transport/logger.
 *
 * Call this before rendering `DbProvider`; the provider owns the subsequent `bootDb` data lifecycle.
 *
 * @param options.transport GraphQL transport used by model relations and actions.
 * @param options.storage Synchronous key/value seam for persistence; defaults to `mmkvStoragePlane()`.
 * @param options.logger Package logger seam; optional, defaults to the built-in logger.
 * @param options.defaults Package-wide freshness/pagination/error-observation defaults (see `DbDefaults`).
 */
export declare const configureDb: (options: ConfigureDbOptions) => void;
export declare const getDbRuntimeConfig: () => RuntimeConfig;
/**
 * Internal: the package-owned TanStack QueryClient behind every remote relation
 * freshness decision. Never exposed to consumers - the library stays the only QueryClient owner.
 * Query retry policy maps our `DbRetryPolicy` formula onto react-query's retry/retryDelay pair;
 * `networkMode: 'always'` keeps react-query out of connectivity decisions - the coordinator's own
 * network gate (`setFetchNetworkOnline`) pauses fetch paths and subscription retries while offline.
 */
export declare const getDbQueryClient: () => QueryClient;
/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
export declare const isDbConfigured: () => boolean;
export declare const getStoragePrefix: () => string;
/** Internal: consumer-owned cache version checked by the persistence manifest reconcile on boot. */
export declare const getPersistenceDataVersion: () => string | null;
export { advanceRuntimeGeneration, getRuntimeGeneration };
export declare const getCommitBus: () => CommitBus;
/**
 * One apply runtime per configured database: every model shares the same epoch counter and commit
 * bus, so one plan touching several models applies and persists as one transaction. Persistence is
 * immediate: every commit writes its dirty row, scope and ledger entries before it publishes.
 */
export declare const getApplyRuntime: () => ApplyRuntime;
/**
 * Remove storage keys outside the library namespace during startup housekeeping for the dedicated
 * storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb()` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
export declare const purgeForeignStorageKeys: () => number;
/** Internal: discard per-runtime apply and ledger caches after storage has been wiped. */
export declare const resetPersistenceRuntime: () => void;
/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export declare const getOperationState: () => OperationState;
//# sourceMappingURL=configure.d.ts.map