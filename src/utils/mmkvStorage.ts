import type { StorageEventApi } from '@tanstack/db';
import { AppState } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

const dbStorage = createMMKV({ id: 'tanstack-db' });

/**
 * Write-back buffer over MMKV. TanStack DB persists by re-serializing a WHOLE collection (full
 * `JSON.stringify`) on every transaction commit, then calling `setItem`. During a burst of feed/chat
 * page loads and subscription syncs the same large collection (measured: `users` ~520KB, `moments`
 * ~1.1MB, re-written ~11x/session) is rewritten repeatedly — each a synchronous mmap write on the JS
 * thread.
 *
 * This buffer coalesces those writes: `setItem`/`removeItem` update an in-memory pending map immediately
 * and (re)arm a trailing flush; the actual MMKV write happens once per quiet window instead of once per
 * commit, so a burst of N rewrites of the same key collapses to one disk write of its final value. Reads
 * (`getItem`, key enumeration) consult the pending map FIRST, so a deferred write is never observed stale.
 * A max-wait cap bounds how long a write can sit unflushed under continuous activity, and app
 * background/inactive forces an immediate flush so nothing is lost on suspend.
 */
const FLUSH_DEBOUNCE_MS = 300;
const FLUSH_MAX_WAIT_MS = 1000;

const DELETED = Symbol('mmkv-pending-delete');

const pendingWrites = new Map<string, string | typeof DELETED>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt = 0;

const flushPendingWrites = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  firstPendingAt = 0;
  if (pendingWrites.size === 0) {
    return;
  }

  const entries = Array.from(pendingWrites.entries());
  pendingWrites.clear();
  for (const [key, value] of entries) {
    if (value === DELETED) {
      dbStorage.remove(key);
    } else {
      dbStorage.set(key, value);
    }
  }
};

const scheduleFlush = (): void => {
  const now = Date.now();
  if (firstPendingAt === 0) {
    firstPendingAt = now;
  }

  if (now - firstPendingAt >= FLUSH_MAX_WAIT_MS) {
    flushPendingWrites();
    return;
  }

  if (flushTimer !== null) {
    clearTimeout(flushTimer);
  }
  const remainingMaxWait = FLUSH_MAX_WAIT_MS - (now - firstPendingAt);
  flushTimer = setTimeout(flushPendingWrites, Math.min(FLUSH_DEBOUNCE_MS, remainingMaxWait));
};

AppState.addEventListener('change', state => {
  if (state === 'background' || state === 'inactive') {
    flushPendingWrites();
  }
});

/** Default MMKV-backed storage adapter with debounced write-back. */
export const mmkvStorageAdapter = {
  getItem: (key: string): string | null => {
    const pending = pendingWrites.get(key);
    if (pending !== undefined) {
      return pending === DELETED ? null : pending;
    }
    return dbStorage.getString(key) ?? null;
  },
  setItem: (key: string, value: string): void => {
    pendingWrites.set(key, value);
    scheduleFlush();
  },
  removeItem: (key: string): void => {
    pendingWrites.set(key, DELETED);
    scheduleFlush();
  }
};

/** Clear all DB keys from MMKV and pending writes. */
export const clearDbStorage = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingWrites.clear();
  firstPendingAt = 0;
  dbStorage.clearAll();
};

/** Return all DB storage keys, including pending writes. */
export const getDbStorageKeys = (): string[] => {
  const keys = new Set(dbStorage.getAllKeys());
  for (const [key, value] of pendingWrites) {
    if (value === DELETED) {
      keys.delete(key);
    } else {
      keys.add(key);
    }
  }
  return Array.from(keys);
};

/** Remove one DB storage key through the write-back buffer. */
export const removeDbStorageKey = (key: string): void => {
  pendingWrites.set(key, DELETED);
  scheduleFlush();
};

/** Inert storage event API for MMKV, which has no cross-tab events. */
export const mmkvStorageEventApi: StorageEventApi = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {}
};
