import { getDbStorageAdapter } from '../storage';

/** Atomic-enough synchronous storage seam used by all v6 state planes. */
export interface StoragePlane {
  get(key: string): string | undefined;
  set(entries: Array<{ key: string; value: string | null }>): void;
  keys(prefix: string): string[];
}

export const mmkvStoragePlane = (): StoragePlane => ({
  get: key => getDbStorageAdapter().getItem(key) ?? undefined,
  set: entries => {
    const storage = getDbStorageAdapter();
    for (const entry of entries) {
      if (entry.value === null) storage.removeItem(entry.key);
      else storage.setItem(entry.key, entry.value);
    }
  },
  keys: prefix => getDbStorageAdapter().getAllKeys().filter(key => key.startsWith(prefix))
});
