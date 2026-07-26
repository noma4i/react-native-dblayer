import type { StoragePlane } from '../../../index';
import { createMemoryPlane } from './harness';

/** Creates a synchronous storage plane that can inject one-shot write faults for persistence specs. */
export function createFaultStorage(): {
  /** Storage seam passed to `configureDb({ storage })`. */
  plane: StoragePlane;
  /** Makes the next `count` storage batches fail before any entry is written. */
  failNextSet: (count?: number) => void;
  /** Makes the next storage batch persist its first entries, then fail. */
  truncateNextSet: (afterEntries: number) => void;
  /** Replaces one stored value with malformed data by default. */
  corrupt: (key: string, value?: string) => void;
  /** Returns every storage batch observed by this fault plane in write order. */
  setCalls: () => Array<Array<{ key: string; value: string | null }>>;
} {
  const base = createMemoryPlane();
  const batches: Array<Array<{ key: string; value: string | null }>> = [];
  let remainingFailures = 0;
  let truncateAfter: number | null = null;

  const plane: StoragePlane = {
    get: key => base.get(key),
    set: entries => {
      const batch = entries.map(entry => ({ ...entry }));
      batches.push(batch);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('fault: set failed');
      }
      if (truncateAfter !== null) {
        const limit = truncateAfter;
        truncateAfter = null;
        base.set(batch.slice(0, limit));
        throw new Error('fault: set truncated');
      }
      base.set(batch);
    },
    keys: prefix => base.keys(prefix)
  };

  return {
    plane,
    failNextSet: (count = 1) => {
      remainingFailures = count;
    },
    truncateNextSet: afterEntries => {
      truncateAfter = afterEntries;
    },
    corrupt: (key, value = '{corrupt') => {
      base.set([{ key, value }]);
    },
    setCalls: () => batches.map(batch => batch.map(entry => ({ ...entry })))
  };
}
