import type { StoragePlane } from '../../testApi';
import { createMemoryPlane } from './harness';

/** Creates a synchronous storage plane that can inject one-shot write faults for persistence specs. */
export function createFaultStorage(): {
  /** Storage seam passed to `configureDb({ storage })`. */
  plane: StoragePlane;
  /** Makes the next `count` single-key writes fail before mutation. */
  failNextSet: (count?: number) => void;
  /** Replaces one stored value with malformed data by default. */
  corrupt: (key: string, value?: string) => void;
  /** Returns every single-key write observed by this fault plane in order. */
  setCalls: () => Array<{ key: string; value: string | null }>;
} {
  const base = createMemoryPlane();
  const writes: Array<{ key: string; value: string | null }> = [];
  let remainingFailures = 0;

  const plane: StoragePlane = {
    get: key => base.get(key),
    set: (key, value) => {
      writes.push({ key, value });
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('fault: set failed');
      }
      base.set(key, value);
    },
    keys: prefix => base.keys(prefix)
  };

  return {
    plane,
    failNextSet: (count = 1) => {
      remainingFailures = count;
    },
    corrupt: (key, value = '{corrupt') => {
      base.set(key, value);
    },
    setCalls: () => writes.map(write => ({ ...write }))
  };
}

type FaultStorage = ReturnType<typeof createFaultStorage>;

/** Arms `storage` so the write batch AFTER the next `settleCount` successful batches fails once. */
export const failAfterSettledBatches = (storage: FaultStorage, settleCount: number): void => {
  const set = storage.plane.set;
  let seen = 0;
  storage.plane.set = (key, value) => {
    seen += 1;
    set(key, value);
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
  storage.plane.set = (key, value) => {
    seen += 1;
    set(key, value);
    if (seen === count && captured === null) {
      captured = Object.fromEntries(storage.plane.keys('').map(key => [key, storage.plane.get(key) ?? null]));
    }
  };
  return () => captured ?? {};
};
