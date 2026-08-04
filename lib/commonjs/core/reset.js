"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.resumeInterruptedStorageReset = exports.resetRuntimeForCompatibility = exports.resetRuntime = exports.resetInMemoryRuntime = exports.registerReset = exports.registerKeyedReset = void 0;
var _configure = require("../dsl/configure.js");
var _persistenceCodec = require("./persistenceCodec.js");
var _modelEventRegistry = require("./modelEventRegistry.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const resetters = new Set();
const keyedResetters = new Map();
const resetIntentKey = prefix => `${prefix}reset-intent`;
const STORAGE_RESET_INTENT_VERSION = 1;
const isStorageResetIntent = value => (0, _normalizeHelpers.isNonArrayRecord)(value) && Number.isSafeInteger(value.recordVersion) && Array.isArray(value.restore) && value.restore.every(entry => (0, _normalizeHelpers.isNonArrayRecord)(entry) && typeof entry.key === 'string' && typeof entry.value === 'string');
const readStorageResetIntent = () => {
  const raw = (0, _configure.getDbRuntimeConfig)().storage.get(resetIntentKey((0, _configure.getStoragePrefix)()));
  if (raw === undefined) return undefined;
  const decoded = (0, _persistenceCodec.decodeVersionedRecord)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, STORAGE_RESET_INTENT_VERSION, isStorageResetIntent);
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  return decoded.kind === 'ok' ? decoded.value : {
    recordVersion: STORAGE_RESET_INTENT_VERSION,
    restore: []
  };
};

/**
 * Register in-memory runtime state that `resetRuntime`'s kill-switch must clear. `defineModel` calls this
 * automatically for its own planes; use it directly only for extra runtime state defined outside a model.
 *
 * @param reset Synchronous cleanup callback; `resetRuntime` throws if it returns a `Promise`.
 * @returns Unregister function - call it to stop the resetter from running on future resets.
 */
const registerReset = reset => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/**
 * Keyed variant of {@link registerReset} for state owned by a re-runnable DEFINITION (a
 * `define*` call). Re-registering the same key REPLACES the previous resetter, so redefining a
 * query/model (e.g. Fast Refresh) never accumulates resetters for dead closures.
 *
 * @param key Stable definition identity, e.g. `query:<keyName>` or `model:<modelId>`.
 * @param reset Synchronous cleanup callback; `resetRuntime` throws if it returns a `Promise`.
 */
exports.registerReset = registerReset;
const registerKeyedReset = (key, reset) => {
  keyedResetters.set(key, reset);
};
exports.registerKeyedReset = registerKeyedReset;
const runRegisteredResetters = attempt => {
  for (const reset of [...resetters, ...keyedResetters.values()]) {
    attempt(() => {
      const result = reset();
      if (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function' || typeof result === 'function' && 'then' in result && typeof result.then === 'function') {
        throw new Error('resetRuntime cannot run async resetters - register synchronous reset functions');
      }
    });
  }
};

/** Internal: rebind all registered in-memory state to the current runtime config WITHOUT touching storage. `configureDb` re-entry runs this so no definition keeps planes hydrated from a previously configured storage. */
const resetInMemoryRuntime = () => {
  const resetErrors = [];
  const attempt = reset => {
    try {
      reset();
    } catch (error) {
      resetErrors.push(error);
    }
  };
  runRegisteredResetters(attempt);
  if (resetErrors.length > 0) throw new AggregateError(resetErrors, 'configureDb failed to run one or more resetters');
};
exports.resetInMemoryRuntime = resetInMemoryRuntime;
const resetRuntimeWithRecovery = restore => {
  if (!(0, _configure.isDbConfigured)()) return;
  (0, _configure.advanceRuntimeGeneration)();
  const resetErrors = [];
  const attempt = reset => {
    try {
      reset();
    } catch (error) {
      resetErrors.push(error);
    }
  };
  attempt(_configure.resetPersistenceRuntime);
  const {
    storage
  } = (0, _configure.getDbRuntimeConfig)();
  const intentKey = resetIntentKey((0, _configure.getStoragePrefix)());
  try {
    storage.set(intentKey, (0, _persistenceCodec.encodePersistence)({
      recordVersion: STORAGE_RESET_INTENT_VERSION,
      restore: restore.map(entry => ({
        ...entry
      }))
    }));
  } catch (error) {
    throw new AggregateError([error], 'resetRuntime failed to persist reset intent');
  }
  const clearStorage = () => {
    const keys = storage.keys((0, _configure.getStoragePrefix)());
    for (const key of keys) {
      if (key !== intentKey) storage.set(key, null);
    }
  };
  attempt(clearStorage);
  runRegisteredResetters(attempt);
  attempt(() => (0, _configure.getOperationState)().reset());
  attempt(() => (0, _configure.getCommitBus)().publishAll());
  let finalStorageClearSucceeded = true;
  try {
    clearStorage();
  } catch (error) {
    finalStorageClearSucceeded = false;
    resetErrors.push(error);
  }
  if (finalStorageClearSucceeded) {
    for (const entry of restore) {
      try {
        storage.set(entry.key, entry.value);
      } catch (error) {
        finalStorageClearSucceeded = false;
        resetErrors.push(error);
        break;
      }
    }
  }
  if (finalStorageClearSucceeded) attempt(() => storage.set(intentKey, null));
  attempt(_modelEventRegistry.restartModelEventRegistry);
  if (resetErrors.length > 0) throw new AggregateError(resetErrors, 'resetRuntime failed to run one or more resetters');
};

/**
 * KILL-SWITCH: full invalidation in one call. Discards pending checkpoint snapshots, deletes every
 * persisted key under the library namespace, clears all registered in-memory state and notifies
 * every live subscriber. The commit bus `publishAll` is the single wake-up channel for mounted
 * readers: each one re-acquires its handle from the new generation, so the first post-reset render
 * already serves the new runtime's data without a remount. There is no partial/per-model variant -
 * the host app decides when to pull it (e.g. on logout). Fully synchronous by design: state is
 * clean the moment the call returns, with no deferred teardown to await - seeding and subsequent
 * reads can rely on it immediately. An async resetter is a registration error and throws. No-ops
 * when `configureDb` has never run - an unconfigured runtime is trivially clean. Every resetter
 * runs even when another throws; failures are rethrown together as an `AggregateError` after
 * storage and in-memory state are fully reset.
 */
const resetRuntime = () => resetRuntimeWithRecovery([]);
exports.resetRuntime = resetRuntime;
const resumeInterruptedStorageReset = () => {
  if (!(0, _configure.isDbConfigured)()) return false;
  const intent = readStorageResetIntent();
  if (intent === undefined) return false;
  resetRuntimeWithRecovery(intent.restore);
  return true;
};
exports.resumeInterruptedStorageReset = resumeInterruptedStorageReset;
const resetRuntimeForCompatibility = restore => resetRuntimeWithRecovery(restore);
exports.resetRuntimeForCompatibility = resetRuntimeForCompatibility;
//# sourceMappingURL=reset.js.map