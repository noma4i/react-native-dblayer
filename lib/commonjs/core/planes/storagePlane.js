"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.mmkvStoragePlane = void 0;
var _storage = require("../storage.js");
/** Atomic-enough synchronous storage seam used by all v6 state planes. */

const mmkvStoragePlane = () => ({
  get: key => (0, _storage.getDbStorageAdapter)().getItem(key) ?? undefined,
  set: entries => {
    const storage = (0, _storage.getDbStorageAdapter)();
    for (const entry of entries) {
      if (entry.value === null) storage.removeItem(entry.key);else storage.setItem(entry.key, entry.value);
    }
  },
  keys: prefix => (0, _storage.getDbStorageAdapter)().getAllKeys().filter(key => key.startsWith(prefix))
});
exports.mmkvStoragePlane = mmkvStoragePlane;
//# sourceMappingURL=storagePlane.js.map