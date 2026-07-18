/** Atomic-enough synchronous storage seam used by all v6 state planes. */
export interface StoragePlane {
    get(key: string): string | undefined;
    set(entries: Array<{
        key: string;
        value: string | null;
    }>): void;
    keys(prefix: string): string[];
}
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
export declare const mmkvStoragePlane: () => StoragePlane;
//# sourceMappingURL=storagePlane.d.ts.map