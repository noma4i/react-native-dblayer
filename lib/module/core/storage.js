"use strict";

let mmkvStorageModule = null;
const getMmkvStorageModule = () => {
  mmkvStorageModule ??= require('../utils/mmkvStorage');
  return mmkvStorageModule;
};
const defaultStorageAdapter = {
  getItem: key => getMmkvStorageModule().mmkvStorageAdapter.getItem(key),
  setItem: (key, value) => getMmkvStorageModule().mmkvStorageAdapter.setItem(key, value),
  removeItem: key => getMmkvStorageModule().removeDbStorageKey(key),
  getAllKeys: () => getMmkvStorageModule().getDbStorageKeys(),
  clear: () => getMmkvStorageModule().clearDbStorage(),
  eventApi: {
    addEventListener: (...args) => getMmkvStorageModule().mmkvStorageEventApi.addEventListener(...args),
    removeEventListener: (...args) => getMmkvStorageModule().mmkvStorageEventApi.removeEventListener(...args)
  }
};
let currentStorageAdapter = defaultStorageAdapter;

/** Set the synchronous storage adapter used by persistent collections. */
export const setDbStorageAdapter = adapter => {
  currentStorageAdapter = adapter;
};

/** Get the currently configured storage adapter. */
export const getDbStorageAdapter = () => currentStorageAdapter;
//# sourceMappingURL=storage.js.map