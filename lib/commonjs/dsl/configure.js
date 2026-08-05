"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "advanceRuntimeGeneration", {
  enumerable: true,
  get: function () {
    return _runtimeGeneration.advanceRuntimeGeneration;
  }
});
exports.getPersistenceDataVersion = exports.getOperationState = exports.getDbRuntimeConfig = exports.getDbQueryClient = exports.getCommitBus = exports.getApplyRuntime = exports.configureDb = void 0;
Object.defineProperty(exports, "getRuntimeGeneration", {
  enumerable: true,
  get: function () {
    return _runtimeGeneration.getRuntimeGeneration;
  }
});
exports.resetPersistenceRuntime = exports.purgeForeignStorageKeys = exports.isDbConfigured = exports.getStoragePrefix = void 0;
var _reactQuery = require("@tanstack/react-query");
var _retryPolicy = require("../core/fetch/retryPolicy.js");
var _storagePlane = require("../core/planes/storagePlane.js");
var _logger = require("../core/logger.js");
var _transport = require("../core/transport.js");
var _commitBus = require("../core/apply/commitBus.js");
var _transaction = require("../core/apply/transaction.js");
var _operationState = require("../core/planes/operationState.js");
var _reset = require("../core/reset.js");
var _residency = require("../core/residency.js");
var _store = require("../core/store.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _modelEventRegistry = require("../core/modelEventRegistry.js");
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
let queryClient = null;
const commitBus = (0, _commitBus.createCommitBus)();
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
const configureDb = options => {
  // Land coalesced cache snapshots of the outgoing runtime before its generation dies.
  applyRuntime?.flushCacheSnapshots();
  (0, _runtimeGeneration.advanceRuntimeGeneration)();
  (0, _reset.resetInMemoryRuntime)();
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
    storage: options.storage ?? (0, _storagePlane.mmkvStoragePlane)(),
    dataVersion: options.dataVersion ?? null
  };
  applyRuntime = null;
  operationState = null;
  queryClient = null; // Orphan, never clear(): cancelling in-flight fetches rejects their retryer promises as unhandled CancelledErrors.
  (0, _transport.setDbTransport)(options.transport);
  if (options.logger) (0, _logger.setDbLogger)(options.logger);
  getApplyRuntime();
  (0, _modelEventRegistry.restartModelEventRegistry)();
  if (!storeResetRegistered) {
    (0, _reset.registerReset)(_store.resetStores);
    storeResetRegistered = true;
  }
};
exports.configureDb = configureDb;
const getDbRuntimeConfig = () => {
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
exports.getDbRuntimeConfig = getDbRuntimeConfig;
const getDbQueryClient = () => {
  if (queryClient) return queryClient;
  if (!queryClientResetRegistered) {
    (0, _reset.registerReset)(() => {
      queryClient?.unmount();
      queryClient = null; // Orphaned with its generation; see configureDb.
    });
    queryClientResetRegistered = true;
  }
  const generation = (0, _runtimeGeneration.getRuntimeGeneration)();
  queryClient = new _reactQuery.QueryClient({
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
        retry: (failureCount, error) => (0, _runtimeGeneration.getRuntimeGeneration)() === generation && (0, _retryPolicy.retryDelayMs)(getDbRuntimeConfig().defaults.retry?.query ?? {}, error, failureCount + 1) !== null,
        retryDelay: (failureCount, error) => (0, _runtimeGeneration.getRuntimeGeneration)() === generation ? (0, _retryPolicy.retryDelayMs)(getDbRuntimeConfig().defaults.retry?.query ?? {}, error, failureCount) ?? 0 : 0
      }
    }
  });
  // Mounting is what connects the cache to connectivity: without it a fetch paused offline is never
  // resumed, because nothing tells the cache the network came back.
  queryClient.mount();
  return queryClient;
};

/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
exports.getDbQueryClient = getDbQueryClient;
const isDbConfigured = () => runtimeConfig !== null;
exports.isDbConfigured = isDbConfigured;
const getStoragePrefix = () => STORAGE_PREFIX;

/** Internal: consumer-owned cache version checked by the persistence manifest reconcile on boot. */
exports.getStoragePrefix = getStoragePrefix;
const getPersistenceDataVersion = () => getDbRuntimeConfig().dataVersion;
exports.getPersistenceDataVersion = getPersistenceDataVersion;
const getCommitBus = () => commitBus;

/**
 * One apply runtime per configured database: every model shares the same epoch counter and commit
 * bus, so one plan touching several models applies and persists as one transaction. Persistence is
 * immediate: every commit writes its dirty row, scope and ledger entries before it publishes.
 */
exports.getCommitBus = getCommitBus;
const getApplyRuntime = () => {
  if (!applyRuntime) {
    const {
      storage
    } = getDbRuntimeConfig();
    applyRuntime = (0, _transaction.createApplyRuntime)({
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
exports.getApplyRuntime = getApplyRuntime;
const purgeForeignStorageKeys = () => {
  const {
    storage
  } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  for (const key of foreign) storage.set(key, null);
  return foreign.length;
};

/** Internal: discard per-runtime apply and ledger caches after storage has been wiped. */
exports.purgeForeignStorageKeys = purgeForeignStorageKeys;
const resetPersistenceRuntime = () => {
  applyRuntime = null;
  operationState = null;
};
exports.resetPersistenceRuntime = resetPersistenceRuntime;
(0, _residency.registerResidency)('operationRowBuckets', () => operationState?.residentRowBuckets() ?? 0);

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
const getOperationState = () => {
  if (!operationState) {
    const {
      storage
    } = getDbRuntimeConfig();
    operationState = (0, _operationState.createOperationState)({
      storage,
      prefix: getStoragePrefix,
      now: () => Date.now()
    });
    operationState.hydrate();
  }
  return operationState;
};
exports.getOperationState = getOperationState;
//# sourceMappingURL=configure.js.map