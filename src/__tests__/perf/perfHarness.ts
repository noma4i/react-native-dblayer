import type { Dependency } from '../../core/apply/commitBus';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { getCommitBus } from '../../dsl/configure';
import { createMemoryStorage, type StorageCounters } from '../helpers/memoryStorage';

/** In-memory storage plane that counts persistence work for counted perf specs. */
export const createCountingStorage = (): { plane: StoragePlane; counters: StorageCounters; resetCounters: () => void } => {
  const memory = createMemoryStorage();
  return {
    plane: memory.storage,
    counters: memory.counters,
    resetCounters: memory.resetCounters
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
