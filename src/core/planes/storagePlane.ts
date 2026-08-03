import { getDbStorageAdapter } from '../storage';
import type { StoragePlane } from '../../types';

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
export const mmkvStoragePlane = (): StoragePlane => ({
  get: key => getDbStorageAdapter().getItem(key) ?? undefined,
  set: (key, value) => {
    const storage = getDbStorageAdapter();
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  },
  keys: prefix =>
    getDbStorageAdapter()
      .allKeys()
      .filter(key => key.startsWith(prefix))
});
