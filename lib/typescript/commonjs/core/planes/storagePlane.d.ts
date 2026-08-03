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
export declare const mmkvStoragePlane: () => StoragePlane;
//# sourceMappingURL=storagePlane.d.ts.map