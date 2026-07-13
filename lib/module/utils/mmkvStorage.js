"use strict";

let dbStorage = null;
const getDbStorage = () => {
  if (dbStorage === null) {
    dbStorage = require('react-native-mmkv').createMMKV({
      id: 'tanstack-db'
    });
  }
  return dbStorage;
};

/** Default direct MMKV-backed storage adapter. Collection serialization owns deferral. */
export const mmkvStorageAdapter = {
  getItem: key => getDbStorage().getString(key) ?? null,
  setItem: (key, value) => {
    getDbStorage().set(key, value);
  },
  removeItem: key => {
    getDbStorage().remove(key);
  }
};

/** Clear all DB keys from MMKV. */
export const clearDbStorage = () => {
  getDbStorage().clearAll();
};

/** Return all DB storage keys. */
export const getDbStorageKeys = () => getDbStorage().getAllKeys();

/** Remove one DB storage key. */
export const removeDbStorageKey = key => {
  getDbStorage().remove(key);
};

/** Inert storage event API for MMKV, which has no cross-tab events. */
export const mmkvStorageEventApi = {
  addEventListener: () => {},
  removeEventListener: () => {}
};
//# sourceMappingURL=mmkvStorage.js.map