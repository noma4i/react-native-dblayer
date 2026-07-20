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
  clear: () => getMmkvStorageModule().clearDbStorage()
};
const currentStorageAdapter = createConfiguredSlot(defaultStorageAdapter);

/** Get the currently configured storage adapter. */
export const getDbStorageAdapter = () => currentStorageAdapter.get();
//# sourceMappingURL=storage.js.map