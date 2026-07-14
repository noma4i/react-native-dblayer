"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbStorageAdapter = exports.getDbStorageAdapter = void 0;
var _configuredSlot = require("./configuredSlot.js");
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
const currentStorageAdapter = (0, _configuredSlot.createConfiguredSlot)(defaultStorageAdapter);

/** Set the synchronous storage adapter used by persistent collections. */
const setDbStorageAdapter = adapter => {
  currentStorageAdapter.set(adapter);
};

/** Get the currently configured storage adapter. */
exports.setDbStorageAdapter = setDbStorageAdapter;
const getDbStorageAdapter = () => currentStorageAdapter.get();
exports.getDbStorageAdapter = getDbStorageAdapter;
//# sourceMappingURL=storage.js.map