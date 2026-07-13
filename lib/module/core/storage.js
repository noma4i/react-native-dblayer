"use strict";

import { createConfiguredSlot } from "./configuredSlot.js";
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
const currentStorageAdapter = createConfiguredSlot(defaultStorageAdapter);

/** Set the synchronous storage adapter used by persistent collections. */
export const setDbStorageAdapter = adapter => {
  currentStorageAdapter.set(adapter);
};

/** Get the currently configured storage adapter. */
export const getDbStorageAdapter = () => currentStorageAdapter.get();
//# sourceMappingURL=storage.js.map