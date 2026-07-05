"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.removeDbStorageKey = exports.mmkvStorageEventApi = exports.mmkvStorageAdapter = exports.getDbStorageKeys = exports.clearDbStorage = void 0;
let dbStorage = null;
let appStateListenerRegistered = false;
const getDbStorage = () => {
  if (dbStorage === null) {
    dbStorage = require('react-native-mmkv').createMMKV({
      id: 'tanstack-db'
    });
  }
  if (!appStateListenerRegistered) {
    appStateListenerRegistered = true;
    require('react-native').AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        flushPendingWrites();
      }
    });
  }
  return dbStorage;
};

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
const pendingWrites = new Map();
let flushTimer = null;
let firstPendingAt = 0;
const flushPendingWrites = () => {
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
      getDbStorage().remove(key);
    } else {
      getDbStorage().set(key, value);
    }
  }
};
const scheduleFlush = () => {
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

/** Default MMKV-backed storage adapter with debounced write-back. */
const mmkvStorageAdapter = exports.mmkvStorageAdapter = {
  getItem: key => {
    const pending = pendingWrites.get(key);
    if (pending !== undefined) {
      return pending === DELETED ? null : pending;
    }
    return getDbStorage().getString(key) ?? null;
  },
  setItem: (key, value) => {
    pendingWrites.set(key, value);
    scheduleFlush();
  },
  removeItem: key => {
    pendingWrites.set(key, DELETED);
    scheduleFlush();
  }
};

/** Clear all DB keys from MMKV and pending writes. */
const clearDbStorage = () => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pendingWrites.clear();
  firstPendingAt = 0;
  getDbStorage().clearAll();
};

/** Return all DB storage keys, including pending writes. */
exports.clearDbStorage = clearDbStorage;
const getDbStorageKeys = () => {
  const keys = new Set(getDbStorage().getAllKeys());
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
exports.getDbStorageKeys = getDbStorageKeys;
const removeDbStorageKey = key => {
  pendingWrites.set(key, DELETED);
  scheduleFlush();
};

/** Inert storage event API for MMKV, which has no cross-tab events. */
exports.removeDbStorageKey = removeDbStorageKey;
const mmkvStorageEventApi = exports.mmkvStorageEventApi = {
  addEventListener: () => {},
  removeEventListener: () => {}
};
//# sourceMappingURL=mmkvStorage.js.map