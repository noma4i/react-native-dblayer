"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getStoragePrefix = exports.getOperationState = exports.getDbRuntimeConfig = exports.getDbQueryClient = exports.getCommitBus = exports.getApplyRuntime = exports.flushPersistence = exports.configureDb = exports.cancelPersistence = void 0;
var _storagePlane = require("../core/planes/storagePlane.js");
var _logger = require("../core/logger.js");
var _tracking = require("../core/tracking.js");
var _transport = require("../core/transport.js");
var _commitBus = require("../core/apply/commitBus.js");
var _checkpoint = require("../core/apply/checkpoint.js");
var _transaction = require("../core/apply/transaction.js");
var _operationState = require("../core/planes/operationState.js");
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
let checkpointScheduler = null;
const commitBus = (0, _commitBus.createCommitBus)();

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
const configureDb = options => {
  runtimeConfig = {
    ...options,
    storage: options.storage ?? (0, _storagePlane.mmkvStoragePlane)()
  };
  applyRuntime = null;
  operationState = null;
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  (0, _transport.setDbTransport)(options.transport);
  if (options.logger) (0, _logger.setDbLogger)(options.logger);
  if (options.track) (0, _tracking.setDbTrackSink)(options.track);
};
exports.configureDb = configureDb;
const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};
exports.getDbRuntimeConfig = getDbRuntimeConfig;
const getStoragePrefix = () => STORAGE_PREFIX;
exports.getStoragePrefix = getStoragePrefix;
const getCommitBus = () => commitBus;

/** App-owned TanStack QueryClient handed to configureDb; undefined until configured. */
exports.getCommitBus = getCommitBus;
const getDbQueryClient = () => runtimeConfig?.queryClient;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 * Persistence is WAL + checkpoint: plans write only their journal record; model snapshots flush
 * through the checkpoint scheduler off the hot path.
 */
exports.getDbQueryClient = getDbQueryClient;
const getApplyRuntime = () => {
  if (!applyRuntime) {
    const {
      storage,
      defaults
    } = getDbRuntimeConfig();
    checkpointScheduler = (0, _checkpoint.createCheckpointScheduler)({
      storage,
      prefix: getStoragePrefix,
      getTarget: _transaction.getApplyTarget,
      delayMs: defaults?.persistence?.checkpointDelayMs ?? 500,
      maxPendingPlans: defaults?.persistence?.maxPendingPlans ?? 25
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
 * must call this on background/inactive and before logout teardown.
 */
exports.getApplyRuntime = getApplyRuntime;
const flushPersistence = () => {
  checkpointScheduler?.flushNow();
};

/** Internal: kill-switch discards pending snapshots (storage is being wiped anyway). */
exports.flushPersistence = flushPersistence;
const cancelPersistence = () => {
  checkpointScheduler?.cancel();
};

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
exports.cancelPersistence = cancelPersistence;
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