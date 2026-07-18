/** Default direct MMKV-backed storage adapter behind the injectable storage seam. */
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
//# sourceMappingURL=mmkvStorage.d.ts.map