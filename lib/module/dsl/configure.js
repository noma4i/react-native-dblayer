"use strict";

import { QueryClient } from '@tanstack/react-query';
import { retryDelayMs } from "../core/fetch/retryPolicy.js";
import { mmkvStoragePlane } from "../core/planes/storagePlane.js";
import { setDbLogger } from "../core/logger.js";
import { setDbTransport } from "../core/transport.js";
import { createCommitBus } from "../core/apply/commitBus.js";
import { createApplyRuntime } from "../core/apply/transaction.js";
import { createOperationState } from "../core/planes/operationState.js";
import { registerReset, resetInMemoryRuntime } from "../core/reset.js";
import { registerResidency } from "../core/residency.js";
import { resetStores } from "../core/store.js";
import { advanceRuntimeGeneration, getRuntimeGeneration } from "../utils/runtimeGeneration.js";
import { restartModelEventRegistry } from "../core/modelEventRegistry.js";
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
let queryClient = null;
const commitBus = createCommitBus();
let storeResetRegistered = false;
let queryClientResetRegistered = false;

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

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
export const configureDb = options => {
  // Land coalesced cache snapshots of the outgoing runtime before its generation dies.
  applyRuntime?.flushCacheSnapshots();
  advanceRuntimeGeneration();
  resetInMemoryRuntime();
  const declaredChunkSize = options.defaults?.resumeRefetch?.chunkSize;
  if (declaredChunkSize !== undefined && (!Number.isInteger(declaredChunkSize) || declaredChunkSize <= 0)) {
    throw new Error(`react-native-dblayer: defaults.resumeRefetch.chunkSize must be a positive integer, received ${declaredChunkSize}`);
  }
  const defaults = {
    ...options.defaults,
    resumeStaleTime: options.defaults?.resumeStaleTime === undefined ? 60_000 : options.defaults.resumeStaleTime
  };
  runtimeConfig = {
    ...options,
    defaults,
    storage: options.storage ?? mmkvStoragePlane(),
    dataVersion: options.dataVersion ?? null
  };
  applyRuntime = null;
  operationState = null;
  queryClient = null; // Orphan, never clear(): cancelling in-flight fetches rejects their retryer promises as unhandled CancelledErrors.
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
  getApplyRuntime();
  restartModelEventRegistry();
  if (!storeResetRegistered) {
    registerReset(resetStores);
    storeResetRegistered = true;
  }
  // A mounted reader learns about the new runtime the same way it learns about a reset.
  commitBus.publishAll();
};
export const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

/**
 * Internal: the package-owned TanStack QueryClient behind every remote relation
 * freshness decision. Never exposed to consumers - the library stays the only QueryClient owner.
 * Query retry policy maps our `DbRetryPolicy` formula onto react-query's retry/retryDelay pair;
 * `networkMode: 'always'` keeps react-query out of connectivity decisions - the coordinator's own
 * network gate (`setFetchNetworkOnline`) pauses fetch paths and subscription retries while offline.
 */
export const getDbQueryClient = () => {
  if (queryClient) return queryClient;
  if (!queryClientResetRegistered) {
    registerReset(() => {
      queryClient?.unmount();
      queryClient = null; // Orphaned with its generation; see configureDb.
    });
    queryClientResetRegistered = true;
  }
  const generation = getRuntimeGeneration();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'always',
        staleTime: 0,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
        // Connectivity is not vetoed here: the scheduled path runs in `online` mode, where React
        // Query pauses the attempt until the network returns, and the imperative path refuses to
        // start offline before it ever reaches a retry.
        retry: (failureCount, error) => getRuntimeGeneration() === generation && retryDelayMs(getDbRuntimeConfig().defaults.retry?.query ?? {}, error, failureCount + 1) !== null,
        retryDelay: (failureCount, error) => getRuntimeGeneration() === generation ? retryDelayMs(getDbRuntimeConfig().defaults.retry?.query ?? {}, error, failureCount) ?? 0 : 0
      }
    }
  });
  // Mounting is what connects the cache to connectivity: without it a fetch paused offline is never
  // resumed, because nothing tells the cache the network came back.
  queryClient.mount();
  return queryClient;
};

/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
export const isDbConfigured = () => runtimeConfig !== null;
export const getStoragePrefix = () => STORAGE_PREFIX;

/** Internal: consumer-owned cache version checked by the persistence manifest reconcile on boot. */
export const getPersistenceDataVersion = () => getDbRuntimeConfig().dataVersion;
export { advanceRuntimeGeneration, getRuntimeGeneration };
export const getCommitBus = () => commitBus;

/**
 * One apply runtime per configured database: every model shares the same epoch counter and commit
 * bus, so one plan touching several models applies and persists as one transaction. Persistence is
 * immediate: every commit writes its dirty row, scope and ledger entries before it publishes.
 */
export const getApplyRuntime = () => {
  if (!applyRuntime) {
    const {
      storage
    } = getDbRuntimeConfig();
    applyRuntime = createApplyRuntime({
      storage,
      prefix: getStoragePrefix,
      bus: commitBus
    });
  }
  return applyRuntime;
};

/**
 * Remove storage keys outside the library namespace during startup housekeeping for the dedicated
 * storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb()` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
export const purgeForeignStorageKeys = () => {
  const {
    storage
  } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  for (const key of foreign) storage.set(key, null);
  return foreign.length;
};

/** Internal: discard per-runtime apply and ledger caches after storage has been wiped. */
export const resetPersistenceRuntime = () => {
  applyRuntime = null;
  operationState = null;
};
registerResidency('operationRowBuckets', () => operationState?.residentRowBuckets() ?? 0);

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export const getOperationState = () => {
  if (!operationState) {
    const {
      storage
    } = getDbRuntimeConfig();
    operationState = createOperationState({
      storage,
      prefix: getStoragePrefix,
      now: () => Date.now()
    });
    operationState.hydrate();
  }
  return operationState;
};
//# sourceMappingURL=configure.js.map