import type { createMMKV } from 'react-native-mmkv';

/** The real MMKV instance shape, sourced from the installed `react-native-mmkv` package - not a hand-written mirror. */
type Mmkv = ReturnType<typeof createMMKV>;

/**
 * The subset of the real MMKV surface this package's storage adapter (`src/utils/mmkvStorage.ts`) actually
 * calls. Binding the jest fake to this real-package-derived type means a future rename on either side
 * (e.g. the `allKeys`/`getAllKeys` drift fixed in 8.0.0-beta.4) fails `tsc` instead of silently boot-crashing
 * on device.
 */
export type UsedMmkvMethods = Pick<Mmkv, 'getString' | 'set' | 'remove' | 'getAllKeys' | 'clearAll'>;

const stores = new Map<string, Map<string, string>>();

const getStore = (id: string | undefined): Map<string, string> => {
  const key = id ?? 'default';
  let store = stores.get(key);
  if (!store) {
    store = new Map();
    stores.set(key, store);
  }
  return store;
};

/** In-memory MMKV fake for jest, type-bound to {@link UsedMmkvMethods}. */
export const createMockMmkv = (options?: { id?: string }): UsedMmkvMethods => {
  const store = getStore(options?.id);
  const fake: UsedMmkvMethods = {
    getString: key => store.get(key),
    set: (key, value) => {
      store.set(key, String(value));
    },
    remove: key => store.delete(key),
    getAllKeys: () => Array.from(store.keys()),
    clearAll: () => {
      store.clear();
    }
  };
  return fake;
};

/** Clears every fake MMKV instance store (all ids) - test-only reset between cases. */
export const resetAllMockMmkvStores = (): void => {
  stores.clear();
};
