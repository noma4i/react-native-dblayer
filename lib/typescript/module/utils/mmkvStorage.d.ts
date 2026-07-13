import type { StorageEventApi } from '@tanstack/db';
/** Default direct MMKV-backed storage adapter. Collection serialization owns deferral. */
export declare const mmkvStorageAdapter: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};
/** Clear all DB keys from MMKV. */
export declare const clearDbStorage: () => void;
/** Return all DB storage keys. */
export declare const getDbStorageKeys: () => string[];
/** Remove one DB storage key. */
export declare const removeDbStorageKey: (key: string) => void;
/** Inert storage event API for MMKV, which has no cross-tab events. */
export declare const mmkvStorageEventApi: StorageEventApi;
//# sourceMappingURL=mmkvStorage.d.ts.map