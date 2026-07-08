"use strict";

import { getDbStorageAdapter } from "./storage.js";
const FRESHNESS_KEY_PREFIX = 'tanstack-db-freshness:';
const ROOT_SCOPE_KEY = '__root__';
/** Default maximum age before persisted fetch-state metadata is pruned. */
export const DEFAULT_FETCH_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const fetchStateRemovalListeners = new Map();
const collectionFetchStateVersions = new Map();
const collectionFetchStateSubscribers = new Map();
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
const bumpCollectionFetchStateVersion = collectionId => {
  collectionFetchStateVersions.set(collectionId, (collectionFetchStateVersions.get(collectionId) ?? 0) + 1);
  const listeners = collectionFetchStateSubscribers.get(collectionId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
};
const removeFreshnessKey = (key, options) => {
  const parsed = parseFreshnessKey(key);
  if (!parsed) return false;
  const existed = getDbStorageAdapter().getItem(key) !== null;
  getDbStorageAdapter().removeItem(key);
  if (existed || options?.bumpOnMissing === true) {
    notifyFetchStateRemoved(parsed.collectionId, parsed.scopeKey);
    bumpCollectionFetchStateVersion(parsed.collectionId);
  }
  return existed;
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
const isPlainRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const parsePersistedFetchState = raw => {
  const state = parseFetchState(raw);
  if (!state || !raw) return state;
  try {
    const parsed = JSON.parse(raw);
    return {
      ...state,
      ...(isPlainRecord(parsed._freshnessFilter) ? {
        _freshnessFilter: parsed._freshnessFilter
      } : {})
    };
  } catch {
    return state;
  }
};
const parseScopeFromKey = scopeKey => {
  if (!scopeKey) return undefined;
  try {
    const parsed = JSON.parse(scopeKey);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Read persisted fetch-state metadata for a collection scope. */
export const getCollectionFetchState = (collectionId, scopeKey) => parseFetchState(getDbStorageAdapter().getItem(buildFreshnessKey(collectionId, scopeKey)));

/** Persist fetch-state metadata for a collection scope. */
export const setCollectionFetchState = (collectionId, state, scopeKey, scope) => {
  const persisted = {
    ...state,
    ...(scope ? {
      _freshnessFilter: scope
    } : {})
  };
  getDbStorageAdapter().setItem(buildFreshnessKey(collectionId, scopeKey), JSON.stringify(persisted));
  bumpCollectionFetchStateVersion(collectionId);
};

/** Clear fetch-state metadata for one collection scope. */
export const clearCollectionFetchState = (collectionId, scopeKey) => {
  removeFreshnessKey(buildFreshnessKey(collectionId, scopeKey), {
    bumpOnMissing: true
  });
};

/** Clear fetch-state metadata for every scope in one collection. */
export const clearCollectionFetchStates = collectionId => {
  const prefix = buildCollectionPrefix(collectionId);
  let removed = false;
  for (const key of getDbStorageAdapter().getAllKeys()) {
    if (key.startsWith(prefix)) {
      removed = removeFreshnessKey(key) || removed;
    }
  }
  if (!removed) {
    bumpCollectionFetchStateVersion(collectionId);
  }
};

/** Clear all persisted fetch-state metadata. */
export const clearAllFreshnessMetadata = () => {
  for (const key of getDbStorageAdapter().getAllKeys()) {
    if (key.startsWith(FRESHNESS_KEY_PREFIX)) {
      removeFreshnessKey(key);
    }
  }
};

/** List persisted fetch-state scope metadata for one collection. */
export const listCollectionFetchScopes = collectionId => {
  const prefix = buildCollectionPrefix(collectionId);
  const records = [];
  for (const key of getDbStorageAdapter().getAllKeys()) {
    if (!key.startsWith(prefix)) continue;
    const parsed = parseFreshnessKey(key);
    if (!parsed || parsed.collectionId !== collectionId) continue;
    const persisted = parsePersistedFetchState(getDbStorageAdapter().getItem(key));
    if (!persisted) continue;
    const {
      _freshnessFilter,
      ...state
    } = persisted;
    const scope = _freshnessFilter ?? parseScopeFromKey(parsed.scopeKey);
    records.push({
      ...(parsed.scopeKey ? {
        scopeKey: parsed.scopeKey
      } : {}),
      ...(scope ? {
        scope
      } : {}),
      state
    });
  }
  return records;
};

/** Register an in-memory cache listener for freshness removals. */
export const registerCollectionFetchStateCache = (collectionId, listener) => {
  const listeners = fetchStateRemovalListeners.get(collectionId);
  if (listeners) {
    listeners.add(listener);
  } else {
    fetchStateRemovalListeners.set(collectionId, new Set([listener]));
  }
};

/** Subscribe to fetch-state version changes for one collection. */
export const subscribeCollectionFetchState = (collectionId, listener) => {
  const listeners = collectionFetchStateSubscribers.get(collectionId);
  if (listeners) {
    listeners.add(listener);
  } else {
    collectionFetchStateSubscribers.set(collectionId, new Set([listener]));
  }
  return () => {
    const currentListeners = collectionFetchStateSubscribers.get(collectionId);
    currentListeners?.delete(listener);
    if (currentListeners?.size === 0) {
      collectionFetchStateSubscribers.delete(collectionId);
    }
  };
};

/** Read the in-memory fetch-state version for one collection. */
export const getCollectionFetchStateVersion = collectionId => collectionFetchStateVersions.get(collectionId) ?? 0;

/** Remove stale or invalid fetch-state metadata and return the number removed. */
export const pruneStaleFetchStates = (maxAgeMs = DEFAULT_FETCH_STATE_MAX_AGE_MS) => {
  const now = Date.now();
  let removed = 0;
  for (const key of getDbStorageAdapter().getAllKeys()) {
    if (!key.startsWith(FRESHNESS_KEY_PREFIX)) continue;
    const state = parseFetchState(getDbStorageAdapter().getItem(key));
    if (!state || now - state.touchedAt > maxAgeMs) {
      removed += removeFreshnessKey(key) ? 1 : 0;
    }
  }
  return removed;
};
//# sourceMappingURL=freshnessStorage.js.map