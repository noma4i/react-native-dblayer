import type { StorageAdapter } from '../types';
import { createConfiguredSlot } from './configuredSlot';

export type { StorageAdapter };

type MmkvStorageModule = typeof import('../utils/mmkvStorage');

declare const require: <T>(moduleName: string) => T;

let mmkvStorageModule: MmkvStorageModule | null = null;

const getMmkvStorageModule = (): MmkvStorageModule => {
  mmkvStorageModule ??= require<MmkvStorageModule>('../utils/mmkvStorage');
  return mmkvStorageModule;
};

const defaultStorageAdapter: StorageAdapter = {
  getItem: (key: string) => getMmkvStorageModule().mmkvStorageAdapter.getItem(key),
  setItem: (key: string, value: string) => getMmkvStorageModule().mmkvStorageAdapter.setItem(key, value),
  removeItem: (key: string) => getMmkvStorageModule().removeDbStorageKey(key),
  getAllKeys: () => getMmkvStorageModule().getDbStorageKeys(),
  clear: () => getMmkvStorageModule().clearDbStorage()
};

const currentStorageAdapter = createConfiguredSlot(defaultStorageAdapter);

/** Set the synchronous storage adapter used by persistent collections. */
export const setDbStorageAdapter = (adapter: StorageAdapter): void => {
  currentStorageAdapter.set(adapter);
};

/** Get the currently configured storage adapter. */
export const getDbStorageAdapter = (): StorageAdapter => currentStorageAdapter.get();
