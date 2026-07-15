"use strict";

import { getCommitBus, getDbRuntimeConfig, getOperationState, getStoragePrefix, resetPersistenceRuntime } from "../dsl/configure.js";
const resetters = new Set();

/** Register in-memory runtime state that the kill-switch must clear. */
export const registerReset = reset => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/**
 * KILL-SWITCH: full invalidation in one call. Discards pending checkpoint snapshots, deletes every
 * persisted key under the library namespace, clears all registered in-memory state and notifies
 * every live subscriber. There is no partial/per-model variant - the host app decides when to pull
 * it (e.g. on logout). Synchronous by design: state is clean the moment it returns (seeding and
 * teardown can rely on it); an async resetter is a registration error and throws.
 */
export const resetRuntimeSync = () => {
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
    if (result instanceof Promise) throw new Error('resetRuntimeSync cannot run async resetters - register synchronous reset functions');
  }
  getOperationState().reset();
  getCommitBus().publishAll();
};

/** Promise-shaped wrapper kept for call sites that await the kill-switch. */
export const resetRuntime = async () => {
  resetRuntimeSync();
};
//# sourceMappingURL=reset.js.map