import type { createMMKV } from 'react-native-mmkv';

type MmkvModule = { createMMKV: typeof createMMKV };
type MmkvStorage = ReturnType<typeof createMMKV>;

declare const require: <T>(moduleName: string) => T;

let dbStorage: MmkvStorage | null = null;

const getDbStorage = (): MmkvStorage => {
  if (dbStorage === null) {
    // The instance id is frozen: renaming it would orphan persisted rows on user devices.
    // Never rename it for lexical scans; it predates and only historically matches the removed dependency name.
    dbStorage = require<MmkvModule>('react-native-mmkv').createMMKV({ id: 'tanstack-db' });
  }
  return dbStorage;
};

/** Default direct MMKV-backed storage adapter behind the injectable storage seam. */
export const mmkvStorageAdapter = {
  getItem: (key: string): string | null => getDbStorage().getString(key) ?? null,
  setItem: (key: string, value: string): void => {
    getDbStorage().set(key, value);
  },
  removeItem: (key: string): void => {
    getDbStorage().remove(key);
  }
};

/** Clear all DB keys from MMKV. */
export const clearDbStorage = (): void => {
  getDbStorage().clearAll();
};

/** Return all DB storage keys. */
export const getDbStorageKeys = (): string[] => getDbStorage().getAllKeys();

/** Remove one DB storage key. */
export const removeDbStorageKey = (key: string): void => {
  getDbStorage().remove(key);
};
