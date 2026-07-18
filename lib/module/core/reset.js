"use strict";

import { advanceRuntimeGeneration, getCommitBus, getDbRuntimeConfig, getOperationState, getStoragePrefix, resetPersistenceRuntime } from "../dsl/configure.js";
const resetters = new Set();

/**
 * Register in-memory runtime state that `resetRuntime`'s kill-switch must clear. `defineModel` calls this
 * automatically for its own planes; use it directly only for extra runtime state defined outside a model.
 *
 * @param reset Synchronous cleanup callback; `resetRuntime` throws if it returns a `Promise`.
 * @returns Unregister function - call it to stop the resetter from running on future resets.
 */
export const registerReset = reset => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/**
 * KILL-SWITCH: full invalidation in one call. Discards pending checkpoint snapshots, deletes every
 * persisted key under the library namespace, clears all registered in-memory state and notifies
 * every live subscriber. There is no partial/per-model variant - the host app decides when to pull
 * it (e.g. on logout). Fully synchronous by design: state is clean the moment the call returns, with
 * no deferred teardown to await - seeding and subsequent reads can rely on it immediately. An async
 * resetter is a registration error and throws.
 */
export const resetRuntime = () => {
  advanceRuntimeGeneration();
  resetPersistenceRuntime();
  const {
    storage
  } = getDbRuntimeConfig();
  storage.set(storage.keys(getStoragePrefix()).map(key => ({
    key,
    value: null
  })));
  for (const reset of resetters) {
    const result = reset();
    if (result instanceof Promise) throw new Error('resetRuntime cannot run async resetters - register synchronous reset functions');
  }
  getOperationState().reset();
  getCommitBus().publishAll();
};
//# sourceMappingURL=reset.js.map