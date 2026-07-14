"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.resetRuntime = exports.registerReset = void 0;
var _configure = require("../dsl/configure.js");
const resetters = new Set();

/** Register in-memory runtime state that the kill-switch must clear. */
const registerReset = reset => {
  resetters.add(reset);
  return () => resetters.delete(reset);
};

/**
 * KILL-SWITCH: full invalidation in one call. Deletes every persisted key under the library
 * namespace and clears all registered in-memory state. There is no partial/per-model variant -
 * the host app decides when to pull it (e.g. on logout).
 */
exports.registerReset = registerReset;
const resetRuntime = async () => {
  const {
    storage
  } = (0, _configure.getDbRuntimeConfig)();
  storage.set(storage.keys((0, _configure.getStoragePrefix)()).map(key => ({
    key,
    value: null
  })));
  for (const reset of resetters) await reset();
};
exports.resetRuntime = resetRuntime;
//# sourceMappingURL=reset.js.map