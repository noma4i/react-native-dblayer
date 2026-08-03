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
exports.getPersistenceDataVersion = exports.getOperationState = exports.getDbRuntimeConfig = exports.getDbQueryClient = exports.getCommitBus = exports.getApplyRuntime = exports.flushPersistence = exports.configureDb = void 0;
Object.defineProperty(exports, "getRuntimeGeneration", {
  enumerable: true,
  get: function () {
    return _runtimeGeneration.getRuntimeGeneration;
  }
});
exports.resetPersistenceRuntime = exports.replayJournal = exports.purgeForeignStorageKeys = exports.noteMaintenancePersistence = exports.isDbConfigured = exports.getStoragePrefix = void 0;
var _reactQuery = require("@tanstack/react-query");
var _retryPolicy = require("../core/fetch/retryPolicy.js");
var _storagePlane = require("../core/planes/storagePlane.js");
var _logger = require("../core/logger.js");
var _transport = require("../core/transport.js");
var _commitBus = require("../core/apply/commitBus.js");
var _checkpoint = require("../core/apply/checkpoint.js");
var _applyTargetRegistry = require("../core/apply/applyTargetRegistry.js");
var _commitEnvelope = require("../core/apply/commitEnvelope.js");
var _transaction = require("../core/apply/transaction.js");
var _journal = require("../core/apply/journal.js");
var _operationState = require("../core/planes/operationState.js");
var _generateTempId = require("../utils/generateTempId.js");
var _reset = require("../core/reset.js");
var _residency = require("../core/residency.js");
var _maintenanceRegistry = require("./maintenanceRegistry.js");
var _store = require("../core/store.js");
var _serialize = require("../core/serialize.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _modelEventRegistry = require("../core/modelEventRegistry.js");
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
let checkpointScheduler = null;
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
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
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

/** Internal: consumer-owned cache version used by the persistence manifest compatibility gate. */
exports.getStoragePrefix = getStoragePrefix;
const getPersistenceDataVersion = () => getDbRuntimeConfig().dataVersion;
exports.getPersistenceDataVersion = getPersistenceDataVersion;
const getCommitBus = () => commitBus;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 * Persistence is WAL + checkpoint: plans write only their journal record; model snapshots flush
 * through the checkpoint scheduler off the hot path.
 */
exports.getCommitBus = getCommitBus;
const getApplyRuntime = () => {
  if (!applyRuntime) {
    const {
      storage,
      defaults
    } = getDbRuntimeConfig();
    checkpointScheduler = (0, _checkpoint.createCheckpointScheduler)({
      storage,
      prefix: getStoragePrefix,
      getTarget: _applyTargetRegistry.getApplyTarget,
      delayMs: defaults?.persistence?.checkpointDelayMs ?? 500,
      maxPendingPlans: defaults?.persistence?.maxPendingPlans ?? 25,
      extraEntries: () => {
        const operations = getOperationState();
        operations.prune();
        return operations.persistEntries();
      }
    });
    applyRuntime = (0, _transaction.createApplyRuntime)({
      storage,
      prefix: getStoragePrefix,
      bus: commitBus,
      checkpoint: checkpointScheduler
    });
  }
  return applyRuntime;
};

/**
 * Force a checkpoint flush NOW - pending model snapshots hit storage in one batch. The host app
 * must call this on background/inactive and before logout teardown. `suspendDb()` calls this for you
 * as part of the recommended background/teardown sequence.
 */
exports.getApplyRuntime = getApplyRuntime;
const flushPersistence = () => {
  checkpointScheduler?.flushNow();
};

/** Persist plane mutations made by maintenance outside an apply-plan epoch. */
exports.flushPersistence = flushPersistence;
const noteMaintenancePersistence = models => {
  getApplyRuntime();
  checkpointScheduler?.noteMaintenance(models);
};

/**
 * Idempotently re-apply journal records not yet covered by each model's persisted applied-epoch
 * marker. The host app must call this ONCE at startup, after configureDb and after every model
 * module has been imported (apply targets registered) - records touching unregistered models throw.
 * Returns the number of replayed records.
 *
 * `bootDb` calls this before foreign-key cleanup and surfaces the result as
 * `{ replayed }`.
 *
 * @returns The number of journal records replayed.
 */
exports.noteMaintenancePersistence = noteMaintenancePersistence;
const replayJournal = () => {
  const runtime = getApplyRuntime();
  const storage = getDbRuntimeConfig().storage;
  const rowPrefix = (0, _serialize.compositeStorageKey)(getStoragePrefix(), 'row');
  const replayed = runtime.replay();
  const operations = getOperationState();
  const crashedRequests = operations.takeHydratedPending(operation => operation.actionMode === 'request');
  if (crashedRequests.length > 0) {
    const rollbackOps = [];
    const rollbackTransitions = [];
    for (const operation of crashedRequests) {
      const rollbackRow = operation.rollbackRow;
      const rollbackMemberships = operation.rollbackMemberships;
      if (rollbackRow !== undefined && rollbackMemberships !== undefined) {
        rollbackOps.push({
          kind: 'upsert',
          model: operation.model,
          rows: [rollbackRow],
          origin: 'replace'
        });
        for (const membership of rollbackMemberships) {
          rollbackOps.push({
            kind: 'scope-delta',
            model: operation.model,
            scopeKey: membership.scopeKey,
            append: [{
              id: membership.id,
              orderKey: membership.orderKey
            }],
            detach: [membership.id]
          });
        }
      } else if (operation.intent === 'insert' && operation.tempIds.length > 0) {
        rollbackOps.push({
          kind: 'destroy',
          model: operation.model,
          ids: operation.tempIds,
          tombstone: false
        });
      }
      rollbackTransitions.push({
        kind: 'close',
        operationId: operation.operationId,
        status: 'rolledback'
      });
    }
    runtime.commit((0, _commitEnvelope.createCommitEnvelope)(rollbackOps, rollbackTransitions));
  }
  const hasApplyTarget = model => {
    try {
      (0, _applyTargetRegistry.getApplyTarget)(model);
      return true;
    } catch {
      return false;
    }
  };
  const candidates = new Map();
  const noteCandidate = (model, id) => {
    if (typeof id !== 'string' || !(0, _generateTempId.isTempId)(id)) return;
    const ids = candidates.get(model) ?? new Set();
    ids.add(id);
    candidates.set(model, ids);
  };
  for (const key of storage.keys(rowPrefix)) {
    const parts = (0, _serialize.parseCompositeKey)(key.slice(rowPrefix.length));
    if (parts?.length === 2) noteCandidate(parts[0], parts[1]);
  }
  for (const key of storage.keys(`${getStoragePrefix()}journal:`)) {
    const record = (0, _journal.readJournalRecord)(storage, getStoragePrefix(), key);
    for (const operation of record.ops) {
      if (operation.kind !== 'upsert') continue;
      for (const row of operation.rows) noteCandidate(operation.model, row.id);
    }
  }
  const openTempIds = new Set(operations.open().flatMap(operation => operation.tempIds.map(id => (0, _serialize.compositeKey)(operation.model, id))));
  for (const [model, ids] of candidates) {
    const orphanIds = [...ids].filter(id => !openTempIds.has((0, _serialize.compositeKey)(model, id)) && !operations.failedFor(model, id) && !(0, _maintenanceRegistry.isTempRowProtectedByModel)(model, id));
    if (orphanIds.length > 0 && hasApplyTarget(model)) runtime.commit((0, _commitEnvelope.createCommitEnvelope)([{
      kind: 'destroy',
      model,
      ids: orphanIds,
      tombstone: false
    }]));
  }
  flushPersistence();
  return replayed;
};

/**
 * Remove storage keys outside the library namespace during startup housekeeping for the dedicated
 * storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb()` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
exports.replayJournal = replayJournal;
const purgeForeignStorageKeys = () => {
  const {
    storage
  } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  if (foreign.length > 0) storage.set(foreign.map(key => ({
    key,
    value: null
  })));
  return foreign.length;
};

/** Internal: discard per-runtime WAL/checkpoint caches after storage has been wiped. */
exports.purgeForeignStorageKeys = purgeForeignStorageKeys;
const resetPersistenceRuntime = () => {
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
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
      now: () => Date.now(),
      notify: operation => {
        if (operation.model === '' || operation.rowIds.length === 0) return;
        commitBus.publish({
          rows: [],
          scopes: [],
          pending: operation.rowIds.map(id => ({
            model: operation.model,
            id
          }))
        });
      }
    });
    operationState.hydrate();
  }
  return operationState;
};
exports.getOperationState = getOperationState;
//# sourceMappingURL=configure.js.map