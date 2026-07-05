import type { StorageEventApi } from '@tanstack/db';
/** Default MMKV-backed storage adapter with debounced write-back. */
export declare const mmkvStorageAdapter: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};
/** Clear all DB keys from MMKV and pending writes. */
export declare const clearDbStorage: () => void;
/** Return all DB storage keys, including pending writes. */
export declare const getDbStorageKeys: () => string[];
/** Remove one DB storage key through the write-back buffer. */
export declare const removeDbStorageKey: (key: string) => void;
/** Inert storage event API for MMKV, which has no cross-tab events. */
export declare const mmkvStorageEventApi: StorageEventApi;
//# sourceMappingURL=mmkvStorage.d.ts.map