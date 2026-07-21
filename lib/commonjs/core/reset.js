"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.resetRuntime = exports.registerReset = void 0;
var _configure = require("../dsl/configure.js");
const resetters = new Set();

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
 * KILL-SWITCH: full invalidation in one call. Discards pending checkpoint snapshots, deletes every
 * persisted key under the library namespace, clears all registered in-memory state and notifies
 * every live subscriber. There is no partial/per-model variant - the host app decides when to pull
 * it (e.g. on logout). Fully synchronous by design: state is clean the moment the call returns, with
 * no deferred teardown to await - seeding and subsequent reads can rely on it immediately. An async
 * resetter is a registration error and throws. No-ops when `configureDb` has never run - an
 * unconfigured runtime is trivially clean.
 */
exports.registerReset = registerReset;
const resetRuntime = () => {
  if (!(0, _configure.isDbConfigured)()) return;
  (0, _configure.advanceRuntimeGeneration)();
  (0, _configure.resetPersistenceRuntime)();
  const {
    storage
  } = (0, _configure.getDbRuntimeConfig)();
  storage.set(storage.keys((0, _configure.getStoragePrefix)()).map(key => ({
    key,
    value: null
  })));
  for (const reset of resetters) {
    const result = reset();
    if (result instanceof Promise) throw new Error('resetRuntime cannot run async resetters - register synchronous reset functions');
  }
  (0, _configure.getOperationState)().reset();
  (0, _configure.getCommitBus)().publishAll();
};
exports.resetRuntime = resetRuntime;
//# sourceMappingURL=reset.js.map