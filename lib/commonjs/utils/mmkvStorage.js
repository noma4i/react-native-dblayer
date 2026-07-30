"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.removeDbStorageKey = exports.mmkvStorageAdapter = exports.getDbStorageKeys = void 0;
let dbStorage = null;
const getDbStorage = () => {
  if (dbStorage === null) {
    // The instance id is frozen: renaming it would orphan persisted rows on user devices.
    // Never rename it for lexical scans; it predates and only historically matches the removed dependency name.
    dbStorage = require('react-native-mmkv').createMMKV({
      id: 'tanstack-db'
    });
  }
  return dbStorage;
};

/** Default direct MMKV-backed storage adapter behind the injectable storage seam. */
const mmkvStorageAdapter = exports.mmkvStorageAdapter = {
  getItem: key => getDbStorage().getString(key) ?? null,
  setItem: (key, value) => {
    getDbStorage().set(key, value);
  },
  removeItem: key => {
    getDbStorage().remove(key);
  }
};

/** Return all DB storage keys. */
const getDbStorageKeys = () => getDbStorage().getAllKeys();

/** Remove one DB storage key. */
exports.getDbStorageKeys = getDbStorageKeys;
const removeDbStorageKey = key => {
  getDbStorage().remove(key);
};
exports.removeDbStorageKey = removeDbStorageKey;
//# sourceMappingURL=mmkvStorage.js.map