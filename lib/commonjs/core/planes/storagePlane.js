'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.mmkvStoragePlane = void 0;
var _storage = require('../storage.js');
/** Atomic-enough synchronous storage seam used by all v6 state planes. */

/**
 * Build a {@link StoragePlane} backed by the configured MMKV storage adapter (`getDbStorageAdapter()`).
 *
 * `get` returns `undefined` for a missing key. `set` applies entries in order: an entry whose `value` is
 * `null` removes the key, any other entry writes it. `keys` lists every stored key that starts with `prefix`.
 * Calling `getDbStorageAdapter()` lazily on every call means this plane always reads the adapter configured
 * at call time, not at construction time.
 *
 * @returns A fresh `StoragePlane` instance; call once and reuse, no internal state to share.
 */
const mmkvStoragePlane = () => ({
  get: key => (0, _storage.getDbStorageAdapter)().getItem(key) ?? undefined,
  set: entries => {
    const storage = (0, _storage.getDbStorageAdapter)();
    for (const entry of entries) {
      if (entry.value === null) storage.removeItem(entry.key);
      else storage.setItem(entry.key, entry.value);
    }
  },
  keys: prefix =>
    (0, _storage.getDbStorageAdapter)()
      .getAllKeys()
      .filter(key => key.startsWith(prefix))
});
exports.mmkvStoragePlane = mmkvStoragePlane;
//# sourceMappingURL=storagePlane.js.map
