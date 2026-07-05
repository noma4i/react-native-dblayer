"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setCollectionFetchState = exports.registerCollectionFetchStateCache = exports.pruneStaleFetchStates = exports.getCollectionFetchState = exports.clearCollectionFetchStates = exports.clearCollectionFetchState = exports.clearAllFreshnessMetadata = exports.DEFAULT_FETCH_STATE_MAX_AGE_MS = void 0;
var _storage = require("./storage.js");
const FRESHNESS_KEY_PREFIX = 'tanstack-db-freshness:';
const ROOT_SCOPE_KEY = '__root__';
/** Default maximum age before persisted fetch-state metadata is pruned. */
const DEFAULT_FETCH_STATE_MAX_AGE_MS = exports.DEFAULT_FETCH_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const fetchStateRemovalListeners = new Map();
const buildFreshnessKey = (collectionId, scopeKey = ROOT_SCOPE_KEY) => `${FRESHNESS_KEY_PREFIX}${collectionId}:${scopeKey}`;
const buildCollectionPrefix = collectionId => `${FRESHNESS_KEY_PREFIX}${collectionId}:`;
const parseFreshnessKey = key => {
  if (!key.startsWith(FRESHNESS_KEY_PREFIX)) return null;
  const withoutPrefix = key.slice(FRESHNESS_KEY_PREFIX.length);
  const separatorIndex = withoutPrefix.indexOf(':');
  if (separatorIndex <= 0) return null;
  const collectionId = withoutPrefix.slice(0, separatorIndex);
  const scopeKey = withoutPrefix.slice(separatorIndex + 1);
  return {
    collectionId,
    scopeKey: scopeKey === ROOT_SCOPE_KEY ? undefined : scopeKey
  };
};
const notifyFetchStateRemoved = (collectionId, scopeKey) => {
  const listeners = fetchStateRemovalListeners.get(collectionId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(scopeKey);
  }
};
const removeFreshnessKey = key => {
  const parsed = parseFreshnessKey(key);
  if (!parsed) return false;
  (0, _storage.getDbStorageAdapter)().removeItem(key);
  notifyFetchStateRemoved(parsed.collectionId, parsed.scopeKey);
  return true;
};
const parseFetchState = raw => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.touchedAt !== 'number' || !Number.isFinite(parsed.touchedAt) || parsed.touchedAt <= 0) {
      return null;
    }
    return {
      touchedAt: parsed.touchedAt,
      empty: parsed.empty === true,
      pageInfo: parsed.pageInfo
    };
  } catch {
    return null;
  }
};

/** Read persisted fetch-state metadata for a collection scope. */
const getCollectionFetchState = (collectionId, scopeKey) => parseFetchState((0, _storage.getDbStorageAdapter)().getItem(buildFreshnessKey(collectionId, scopeKey)));

/** Persist fetch-state metadata for a collection scope. */
exports.getCollectionFetchState = getCollectionFetchState;
const setCollectionFetchState = (collectionId, state, scopeKey) => {
  (0, _storage.getDbStorageAdapter)().setItem(buildFreshnessKey(collectionId, scopeKey), JSON.stringify(state));
};

/** Clear fetch-state metadata for one collection scope. */
exports.setCollectionFetchState = setCollectionFetchState;
const clearCollectionFetchState = (collectionId, scopeKey) => {
  removeFreshnessKey(buildFreshnessKey(collectionId, scopeKey));
};

/** Clear fetch-state metadata for every scope in one collection. */
exports.clearCollectionFetchState = clearCollectionFetchState;
const clearCollectionFetchStates = collectionId => {
  const prefix = buildCollectionPrefix(collectionId);
  for (const key of (0, _storage.getDbStorageAdapter)().getAllKeys()) {
    if (key.startsWith(prefix)) {
      removeFreshnessKey(key);
    }
  }
};

/** Clear all persisted fetch-state metadata. */
exports.clearCollectionFetchStates = clearCollectionFetchStates;
const clearAllFreshnessMetadata = () => {
  for (const key of (0, _storage.getDbStorageAdapter)().getAllKeys()) {
    if (key.startsWith(FRESHNESS_KEY_PREFIX)) {
      removeFreshnessKey(key);
    }
  }
};

/** Register an in-memory cache listener for freshness removals. */
exports.clearAllFreshnessMetadata = clearAllFreshnessMetadata;
const registerCollectionFetchStateCache = (collectionId, listener) => {
  const listeners = fetchStateRemovalListeners.get(collectionId);
  if (listeners) {
    listeners.add(listener);
  } else {
    fetchStateRemovalListeners.set(collectionId, new Set([listener]));
  }
};

/** Remove stale or invalid fetch-state metadata and return the number removed. */
exports.registerCollectionFetchStateCache = registerCollectionFetchStateCache;
const pruneStaleFetchStates = (maxAgeMs = DEFAULT_FETCH_STATE_MAX_AGE_MS) => {
  const now = Date.now();
  let removed = 0;
  for (const key of (0, _storage.getDbStorageAdapter)().getAllKeys()) {
    if (!key.startsWith(FRESHNESS_KEY_PREFIX)) continue;
    const state = parseFetchState((0, _storage.getDbStorageAdapter)().getItem(key));
    if (!state || now - state.touchedAt > maxAgeMs) {
      removed += removeFreshnessKey(key) ? 1 : 0;
    }
  }
  return removed;
};
exports.pruneStaleFetchStates = pruneStaleFetchStates;
//# sourceMappingURL=freshnessStorage.js.map