import type { Dependency } from '../../core/apply/commitBus';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { getCommitBus } from '../../dsl/configure';

export type StorageCounters = { setBatches: number; setEntries: number; gets: number };

/** In-memory storage plane that counts persistence work for counted perf specs. */
export const createCountingStorage = (): { plane: StoragePlane; counters: StorageCounters; resetCounters: () => void } => {
  const store = new Map<string, string>();
  const counters: StorageCounters = { setBatches: 0, setEntries: 0, gets: 0 };
  return {
    plane: {
      get: key => {
        counters.gets += 1;
        return store.get(key);
      },
      set: entries => {
        counters.setBatches += 1;
        counters.setEntries += entries.length;
        for (const { key, value } of entries) {
          if (value === null) store.delete(key);
          else store.set(key, value);
        }
      },
      keys: prefix => [...store.keys()].filter(key => key.startsWith(prefix))
    },
    counters,
    resetCounters: () => {
      counters.setBatches = 0;
      counters.setEntries = 0;
      counters.gets = 0;
    }
  };
};

/** Count commit-bus notifications delivered to one dependency set. */
export const trackNotifies = (deps: Dependency[]): { count: () => number; unsubscribe: () => void } => {
  let notifies = 0;
  const subscription = getCommitBus().subscribe(() => {
    notifies += 1;
  }, deps);
  return { count: () => notifies, unsubscribe: subscription.unsubscribe };
};

/** Number of journal records currently persisted under the library prefix. */
export const journalRecordCount = (plane: StoragePlane): number => plane.keys('dbl:journal:').length;

/** Best-of-3 wall time for a synchronous workload - the timed-budget primitive. */
export const bestOfThreeMs = (run: () => void): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    run();
    const elapsed = performance.now() - start;
    if (elapsed < best) best = elapsed;
  }
  return best;
};
