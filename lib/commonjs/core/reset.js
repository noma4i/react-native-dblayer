'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.resetRuntime = exports.registerReset = exports.registerKeyedReset = void 0;
var _configure = require('../dsl/configure.js');
const resetters = new Set();
const keyedResetters = new Map();

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

/**
 * KILL-SWITCH: full invalidation in one call. Discards pending checkpoint snapshots, deletes every
 * persisted key under the library namespace, clears all registered in-memory state and notifies
 * every live subscriber. There is no partial/per-model variant - the host app decides when to pull
 * it (e.g. on logout). Fully synchronous by design: state is clean the moment the call returns, with
 * no deferred teardown to await - seeding and subsequent reads can rely on it immediately. An async
 * resetter is a registration error and throws. No-ops when `configureDb` has never run - an
 * unconfigured runtime is trivially clean. Every resetter runs even when another throws; failures
 * are rethrown together as an `AggregateError` after storage and in-memory state are fully reset.
 */
exports.registerKeyedReset = registerKeyedReset;
const resetRuntime = () => {
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
  const { storage } = (0, _configure.getDbRuntimeConfig)();
  const clearStorage = () => {
    const keys = storage.keys((0, _configure.getStoragePrefix)());
    if (keys.length > 0)
      storage.set(
        keys.map(key => ({
          key,
          value: null
        }))
      );
  };
  attempt(clearStorage);
  for (const reset of [...resetters, ...keyedResetters.values()]) {
    attempt(() => {
      const result = reset();
      if (
        (typeof result === 'object' && result !== null && 'then' in result && typeof result.then === 'function') ||
        (typeof result === 'function' && 'then' in result && typeof result.then === 'function')
      ) {
        throw new Error('resetRuntime cannot run async resetters - register synchronous reset functions');
      }
    });
  }
  attempt(() => (0, _configure.getOperationState)().reset());
  attempt(() => (0, _configure.getCommitBus)().publishAll());
  attempt(clearStorage);
  if (resetErrors.length > 0) throw new AggregateError(resetErrors, 'resetRuntime failed to run one or more resetters');
};
exports.resetRuntime = resetRuntime;
//# sourceMappingURL=reset.js.map
