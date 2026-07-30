import type { StoragePlane } from '../../legacyTestApi';
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

type FaultStorage = ReturnType<typeof createFaultStorage>;

/** Arms `storage` so the write batch AFTER the next `settleCount` successful batches fails once. */
export const failAfterSettledBatches = (storage: FaultStorage, settleCount: number): void => {
  const set = storage.plane.set;
  let seen = 0;
  storage.plane.set = entries => {
    seen += 1;
    set(entries);
    if (seen === settleCount) storage.failNextSet(1);
  };
};

/**
 * Attempts `attempt()` with a fault armed for the operation's own last write; disarms any unused fault
 * before the caller inspects durable state. Returns whether the fault actually fired.
 */
export const attemptWithLastWriteFaulted = (storage: FaultStorage, settleCount: number, attempt: () => void): boolean => {
  failAfterSettledBatches(storage, settleCount);
  let threw = false;
  try {
    attempt();
  } catch (error) {
    threw = true;
    expect((error as Error).message).toBe('fault: set failed');
  }
  storage.failNextSet(0);
  return threw;
};

/** Async counterpart of `attemptWithLastWriteFaulted`, for attempts whose failure surfaces as a rejected promise. */
export const attemptAsyncWithLastWriteFaulted = async (storage: FaultStorage, settleCount: number, attempt: () => Promise<unknown>): Promise<boolean> => {
  failAfterSettledBatches(storage, settleCount);
  let threw = false;
  try {
    await attempt();
  } catch (error) {
    threw = true;
    expect((error as Error).message).toBe('fault: set failed');
  }
  storage.failNextSet(0);
  return threw;
};

/**
 * Captures the full durable storage content right after the `count`-th write batch settles, without
 * ever failing a write - for code paths wrapped in their own try/catch, where a thrown fault would be
 * intercepted by that catch's own rollback instead of leaving the true "killed here" snapshot to inspect.
 * Returns a reader for whatever was captured (`{}` if fewer than `count` batches ever happened).
 */
export const snapshotAfterBatches = (storage: FaultStorage, count: number): (() => Record<string, string | null>) => {
  const set = storage.plane.set;
  let seen = 0;
  let captured: Record<string, string | null> | null = null;
  storage.plane.set = entries => {
    seen += 1;
    set(entries);
    if (seen === count && captured === null) {
      captured = Object.fromEntries(storage.plane.keys('').map(key => [key, storage.plane.get(key) ?? null]));
    }
  };
  return () => captured ?? {};
};
