'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.resetPersistenceRuntime =
  exports.replayJournal =
  exports.purgeForeignStorageKeys =
  exports.noteMaintenancePersistence =
  exports.isDbConfigured =
  exports.hasReplayedJournal =
  exports.getStoragePrefix =
  exports.getRuntimeGeneration =
  exports.getOperationState =
  exports.getInternalQueryClient =
  exports.getDbRuntimeConfig =
  exports.getCommitBus =
  exports.getApplyRuntime =
  exports.flushPersistence =
  exports.configureDb =
  exports.cancelPersistence =
  exports.advanceRuntimeGeneration =
    void 0;
var _reactQuery = require('@tanstack/react-query');
var _storagePlane = require('../core/planes/storagePlane.js');
var _logger = require('../core/logger.js');
var _transport = require('../core/transport.js');
var _commitBus = require('../core/apply/commitBus.js');
var _checkpoint = require('../core/apply/checkpoint.js');
var _transaction = require('../core/apply/transaction.js');
var _operationState = require('../core/planes/operationState.js');
var _relations = require('../core/relations.js');
var _generateTempId = require('../utils/generateTempId.js');
var _reset = require('../core/reset.js');
var _facade = require('../core/tanstack/facade.js');
var _mirror = require('../core/tanstack/mirror.js');
var _maintenanceScheduler = require('../core/maintenanceScheduler.js');
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
let checkpointScheduler = null;
let runtimeGeneration = 0;
let replayCompleted = false;
const commitBus = (0, _commitBus.createCommitBus)();
let stopCollectionMirror = null;
let collectionRegistryResetRegistered = false;
let stopMaintenanceScheduler = null;
let maintenanceSchedulerResetRegistered = false;
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
 * @param options.transport GraphQL transport (`query`/`mutation`) used by `defineQuery`/`defineMutation`.
 * @param options.storage Synchronous key/value seam for persistence; defaults to `mmkvStoragePlane()`.
 * @param options.logger Package logger seam; optional, defaults to the built-in logger.
 * @param options.defaults Package-wide freshness/pagination/error-observation defaults (see `DbDefaults`).
 */
const configureDb = options => {
  runtimeConfig?.queryClient.clear();
  runtimeGeneration += 1;
  replayCompleted = false;
  const defaults = options.defaults;
  const retryOptions = policy => ({
    retry: policy?.classify
      ? (failureCount, error) => {
          const classification = policy.classify?.(error) ?? 'fatal';
          if (classification === 'fatal') return false;
          return failureCount < (policy.budgets?.[classification] ?? 0);
        }
      : false,
    retryDelay: attempt => {
      const baseMs = policy?.backoff?.baseMs ?? 1000;
      const maxMs = policy?.backoff?.maxMs ?? 30000;
      return Math.min(baseMs * Math.pow(2, attempt), maxMs);
    }
  });
  const networkMode = defaults?.networkMode ?? 'offlineFirst';
  const queryClient = new _reactQuery.QueryClient({
    defaultOptions: {
      queries: {
        ...retryOptions(defaults?.retry?.query),
        networkMode,
        refetchOnReconnect: defaults?.refetchOnReconnect ?? true,
        refetchOnMount: defaults?.refetchOnMount ?? true,
        refetchOnWindowFocus: false
      },
      mutations: {
        ...retryOptions(defaults?.retry?.mutation),
        networkMode
      }
    }
  });
  runtimeConfig = {
    ...options,
    storage: options.storage ?? (0, _storagePlane.mmkvStoragePlane)(),
    queryClient
  };
  applyRuntime = null;
  operationState = null;
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  (0, _transport.setDbTransport)(options.transport);
  if (options.logger) (0, _logger.setDbLogger)(options.logger);
  if (!queryClientResetRegistered) {
    (0, _reset.registerReset)(() => runtimeConfig?.queryClient.clear());
    queryClientResetRegistered = true;
  }
  getApplyRuntime();
  stopCollectionMirror?.();
  (0, _facade.resetCollectionRegistry)();
  stopCollectionMirror = (0, _mirror.startCollectionMirror)(commitBus);
  if (!collectionRegistryResetRegistered) {
    (0, _reset.registerReset)(_facade.resetCollectionRegistry);
    collectionRegistryResetRegistered = true;
  }
  stopMaintenanceScheduler?.();
  stopMaintenanceScheduler = options.defaults?.inSessionGc === false ? null : (0, _maintenanceScheduler.startMaintenanceScheduler)(options.defaults?.inSessionGc);
  if (!maintenanceSchedulerResetRegistered) {
    (0, _reset.registerReset)(() => {
      stopMaintenanceScheduler?.();
      stopMaintenanceScheduler = null;
    });
    maintenanceSchedulerResetRegistered = true;
  }
};
exports.configureDb = configureDb;
const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
exports.getDbRuntimeConfig = getDbRuntimeConfig;
const isDbConfigured = () => runtimeConfig !== null;

/** Internal: reports whether the current runtime completed journal replay. */
exports.isDbConfigured = isDbConfigured;
const hasReplayedJournal = () => replayCompleted;
exports.hasReplayedJournal = hasReplayedJournal;
const getStoragePrefix = () => STORAGE_PREFIX;

/** Monotonic identity for the configured runtime; async continuations must not cross it. */
exports.getStoragePrefix = getStoragePrefix;
const getRuntimeGeneration = () => runtimeGeneration;

/** Internal: establish a new generation before the reset fence tears down the old runtime. */
exports.getRuntimeGeneration = getRuntimeGeneration;
const advanceRuntimeGeneration = () => {
  runtimeGeneration += 1;
};
exports.advanceRuntimeGeneration = advanceRuntimeGeneration;
const getCommitBus = () => commitBus;

/** Internal: return the library-owned QueryClient for provider and query modules. */
exports.getCommitBus = getCommitBus;
const getInternalQueryClient = () => getDbRuntimeConfig().queryClient;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 * Persistence is WAL + checkpoint: plans write only their journal record; model snapshots flush
 * through the checkpoint scheduler off the hot path.
 */
exports.getInternalQueryClient = getInternalQueryClient;
const getApplyRuntime = () => {
  if (!applyRuntime) {
    const { storage, defaults } = getDbRuntimeConfig();
    checkpointScheduler = (0, _checkpoint.createCheckpointScheduler)({
      storage,
      prefix: getStoragePrefix,
      getTarget: _transaction.getApplyTarget,
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
 * `bootDb` calls this before garbage collection and foreign-key cleanup and surfaces the result as
 * `{ replayed }`.
 *
 * @returns The number of journal records replayed.
 */
exports.noteMaintenancePersistence = noteMaintenancePersistence;
const replayJournal = () => {
  const runtime = getApplyRuntime();
  const storage = getDbRuntimeConfig().storage;
  const rowPrefix = `${getStoragePrefix()}row:`;
  const models = new Set();
  for (const key of storage.keys(rowPrefix)) {
    const model = key.slice(rowPrefix.length).split(':', 1)[0];
    if (model) models.add(model);
  }
  (0, _mirror.seedCollections)([...models]);
  const replayed = runtime.replay();
  const operations = getOperationState();
  const hasApplyTarget = model => {
    try {
      (0, _transaction.getApplyTarget)(model);
      return true;
    } catch {
      return false;
    }
  };
  const orphaned = operations.hydratedPending();
  for (const operation of orphaned) {
    if (operation.tempIds.length > 0 && hasApplyTarget(operation.model)) {
      runtime.apply(
        (0, _relations.expandPlan)([
          {
            kind: 'destroy',
            model: operation.model,
            ids: operation.tempIds,
            tombstone: false
          }
        ])
      );
    }
    operations.close(operation.operationId, 'rolledback');
  }
  const candidates = new Map();
  const noteCandidate = (model, id) => {
    if (typeof id !== 'string' || !(0, _generateTempId.isTempId)(id)) return;
    const ids = candidates.get(model) ?? new Set();
    ids.add(id);
    candidates.set(model, ids);
  };
  for (const key of storage.keys(rowPrefix)) {
    const [model, id] = key.slice(rowPrefix.length).split(':', 2);
    if (model && id) noteCandidate(model, id);
  }
  for (const key of storage.keys(`${getStoragePrefix()}journal:`)) {
    const raw = storage.get(key);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      for (const operation of record.ops ?? []) {
        if (operation.kind !== 'upsert' || !operation.model) continue;
        for (const row of operation.rows ?? []) noteCandidate(operation.model, row.id);
      }
    } catch {}
  }
  const pendingTempIds = new Set(operations.pending().flatMap(operation => operation.tempIds));
  for (const [model, ids] of candidates) {
    const orphanIds = [...ids].filter(id => !pendingTempIds.has(id));
    if (orphanIds.length > 0 && hasApplyTarget(model))
      runtime.apply(
        (0, _relations.expandPlan)([
          {
            kind: 'destroy',
            model,
            ids: orphanIds,
            tombstone: false
          }
        ])
      );
  }
  flushPersistence();
  replayCompleted = true;
  return replayed;
};

/**
 * Remove storage keys outside the library namespace - startup housekeeping that clears pre-v6
 * leftovers from the dedicated storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb(options)` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
exports.replayJournal = replayJournal;
const purgeForeignStorageKeys = () => {
  const { storage } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  if (foreign.length > 0)
    storage.set(
      foreign.map(key => ({
        key,
        value: null
      }))
    );
  return foreign.length;
};

/** Internal: kill-switch discards pending snapshots (storage is being wiped anyway). */
exports.purgeForeignStorageKeys = purgeForeignStorageKeys;
const cancelPersistence = () => {
  checkpointScheduler?.cancel();
};

/** Internal: discard per-runtime WAL/checkpoint caches after storage has been wiped. */
exports.cancelPersistence = cancelPersistence;
const resetPersistenceRuntime = () => {
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  applyRuntime = null;
  operationState = null;
};

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
exports.resetPersistenceRuntime = resetPersistenceRuntime;
const getOperationState = () => {
  if (!operationState) {
    const { storage } = getDbRuntimeConfig();
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
