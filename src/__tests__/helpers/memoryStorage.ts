import type { StoragePlane } from '../../core/planes/storagePlane';

export type StorageCounters = { setBatches: number; setEntries: number; gets: number };

export type MemoryStorage = {
  storage: StoragePlane;
  values: Map<string, string>;
  counters: StorageCounters;
  resetCounters(): void;
};

/** Shared in-memory persistence plane for contract and budget specifications. */
export const createMemoryStorage = (seed: Iterable<readonly [string, string]> = []): MemoryStorage => {
  const values = new Map(seed);
  const counters: StorageCounters = { setBatches: 0, setEntries: 0, gets: 0 };
  return {
    storage: {
      get: key => {
        counters.gets += 1;
        return values.get(key);
      },
      set: entries => {
        counters.setBatches += 1;
        counters.setEntries += entries.length;
        for (const { key, value } of entries) {
          if (value === null) values.delete(key);
          else values.set(key, value);
        }
      },
      keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
    },
    values,
    counters,
    resetCounters: () => {
      counters.setBatches = 0;
      counters.setEntries = 0;
      counters.gets = 0;
    }
  };
};
