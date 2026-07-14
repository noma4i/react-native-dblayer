import { getDbRuntimeConfig, getStoragePrefix } from '../dsl/configure';

const resetters = new Set<() => void | Promise<void>>();

/** Register in-memory runtime state that the kill-switch must clear. */
export const registerReset = (reset: () => void | Promise<void>): (() => void) => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/**
 * KILL-SWITCH: full invalidation in one call. Deletes every persisted key under the library
 * namespace and clears all registered in-memory state. There is no partial/per-model variant -
 * the host app decides when to pull it (e.g. on logout).
 */
export const resetRuntime = async (): Promise<void> => {
  const { storage } = getDbRuntimeConfig();
  storage.set(storage.keys(getStoragePrefix()).map(key => ({ key, value: null })));
  for (const reset of resetters) await reset();
};
