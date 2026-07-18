'use strict';

let dbStorage = null;
const getDbStorage = () => {
  if (dbStorage === null) {
    // The instance id predates v6 and is frozen: renaming it would orphan persisted rows on user devices.
    dbStorage = require('react-native-mmkv').createMMKV({
      id: 'tanstack-db'
    });
  }
  return dbStorage;
};

/** Default direct MMKV-backed storage adapter behind the injectable storage seam. */
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
//# sourceMappingURL=mmkvStorage.js.map
