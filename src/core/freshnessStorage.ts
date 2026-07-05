import type { CollectionFetchState, FetchStateRemovalListener } from '../types';
import { getDbStorageAdapter } from './storage';

const FRESHNESS_KEY_PREFIX = 'tanstack-db-freshness:';
const ROOT_SCOPE_KEY = '__root__';
/** Default maximum age before persisted fetch-state metadata is pruned. */
export const DEFAULT_FETCH_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const fetchStateRemovalListeners = new Map<string, Set<FetchStateRemovalListener>>();

const buildFreshnessKey = (collectionId: string, scopeKey = ROOT_SCOPE_KEY): string => `${FRESHNESS_KEY_PREFIX}${collectionId}:${scopeKey}`;
const buildCollectionPrefix = (collectionId: string): string => `${FRESHNESS_KEY_PREFIX}${collectionId}:`;

const parseFreshnessKey = (key: string): { collectionId: string; scopeKey?: string } | null => {
  if (!key.startsWith(FRESHNESS_KEY_PREFIX)) return null;
  const withoutPrefix = key.slice(FRESHNESS_KEY_PREFIX.length);
  const separatorIndex = withoutPrefix.indexOf(':');
  if (separatorIndex <= 0) return null;
  const collectionId = withoutPrefix.slice(0, separatorIndex);
  const scopeKey = withoutPrefix.slice(separatorIndex + 1);
  return { collectionId, scopeKey: scopeKey === ROOT_SCOPE_KEY ? undefined : scopeKey };
};

const notifyFetchStateRemoved = (collectionId: string, scopeKey?: string): void => {
  const listeners = fetchStateRemovalListeners.get(collectionId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(scopeKey);
  }
};

const removeFreshnessKey = (key: string): boolean => {
  const parsed = parseFreshnessKey(key);
  if (!parsed) return false;
  getDbStorageAdapter().removeItem(key);
  notifyFetchStateRemoved(parsed.collectionId, parsed.scopeKey);
  return true;
};

const parseFetchState = (raw: string | null): CollectionFetchState | null => {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<CollectionFetchState>;
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
export const getCollectionFetchState = (collectionId: string, scopeKey?: string): CollectionFetchState | null =>
  parseFetchState(getDbStorageAdapter().getItem(buildFreshnessKey(collectionId, scopeKey)));

/** Persist fetch-state metadata for a collection scope. */
export const setCollectionFetchState = (collectionId: string, state: CollectionFetchState, scopeKey?: string): void => {
  getDbStorageAdapter().setItem(buildFreshnessKey(collectionId, scopeKey), JSON.stringify(state));
};

/** Clear fetch-state metadata for one collection scope. */
export const clearCollectionFetchState = (collectionId: string, scopeKey?: string): void => {
  removeFreshnessKey(buildFreshnessKey(collectionId, scopeKey));
};

/** Clear fetch-state metadata for every scope in one collection. */
export const clearCollectionFetchStates = (collectionId: string): void => {
  const prefix = buildCollectionPrefix(collectionId);
  for (const key of getDbStorageAdapter().getAllKeys()) {
    if (key.startsWith(prefix)) {
      removeFreshnessKey(key);
    }
  }
};

/** Clear all persisted fetch-state metadata. */
export const clearAllFreshnessMetadata = (): void => {
  for (const key of getDbStorageAdapter().getAllKeys()) {
    if (key.startsWith(FRESHNESS_KEY_PREFIX)) {
      removeFreshnessKey(key);
    }
  }
};

/** Register an in-memory cache listener for freshness removals. */
export const registerCollectionFetchStateCache = (collectionId: string, listener: FetchStateRemovalListener): void => {
  const listeners = fetchStateRemovalListeners.get(collectionId);
  if (listeners) {
    listeners.add(listener);
  } else {
    fetchStateRemovalListeners.set(collectionId, new Set([listener]));
  }
};

/** Remove stale or invalid fetch-state metadata and return the number removed. */
export const pruneStaleFetchStates = (maxAgeMs = DEFAULT_FETCH_STATE_MAX_AGE_MS): number => {
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
