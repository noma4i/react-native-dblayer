type MmkvStorage = {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
  clearAll: () => void;
  getAllKeys: () => string[];
};

type MmkvModule = {
  createMMKV: (options: { id: string }) => MmkvStorage;
};

declare const require: <T>(moduleName: string) => T;

let dbStorage: MmkvStorage | null = null;

const getDbStorage = (): MmkvStorage => {
  if (dbStorage === null) {
    dbStorage = require<MmkvModule>('react-native-mmkv').createMMKV({ id: 'tanstack-db' });
  }
  return dbStorage;
};

/** Default direct MMKV-backed storage adapter. Collection serialization owns deferral. */
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
