"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.mmkvStoragePlane = void 0;
var _storage = require("../storage.js");
/**
 * Build a {@link StoragePlane} backed by the configured MMKV storage adapter (`getDbStorageAdapter()`).
 *
 * `get` returns `undefined` for a missing key. `set(key, null)` removes one key.
 * Any other value replaces one key. `keys` lists stored keys that start with `prefix`.
 * Calling `getDbStorageAdapter()` lazily on every call means this plane always reads the adapter configured
 * at call time, not at construction time.
 *
 * @returns A fresh `StoragePlane` instance; call once and reuse, no internal state to share.
 */
const mmkvStoragePlane = () => ({
  get: key => (0, _storage.getDbStorageAdapter)().getItem(key) ?? undefined,
  set: (key, value) => {
    const storage = (0, _storage.getDbStorageAdapter)();
    if (value === null) storage.removeItem(key);else storage.setItem(key, value);
  },
  keys: prefix => (0, _storage.getDbStorageAdapter)().allKeys().filter(key => key.startsWith(prefix))
});
exports.mmkvStoragePlane = mmkvStoragePlane;
//# sourceMappingURL=storagePlane.js.map