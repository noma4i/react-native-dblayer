import { useCallback, useSyncExternalStore } from 'react';
import { getCollectionFetchStateVersion, subscribeCollectionFetchState } from '../../core/freshnessStorage';
import { getDbLogger } from '../../core/logger';
import type { CollectionFetchState } from '../../types';

/** Freshness decision consumed by base query hooks before the initial fetch. */
export type FreshnessGateDecision = {
  fetchState: CollectionFetchState | null;
  shouldSkip: boolean;
};

/** Log one freshness skip decision for a model scope. */
export const logFreshnessSkip = (model: string | undefined, scopeKey: string, fetchState: CollectionFetchState | null): void => {
  if (!fetchState) return;
  getDbLogger().debug('db', 'freshness:skip', {
    model,
    scopeKey,
    ageMs: Date.now() - fetchState.touchedAt,
    empty: fetchState.empty
  });
};

/** Subscribe to a collection's fetch-state version, or a constant 0 when no collection is bound. */
export const useCollectionFetchStateVersion = (collectionId: string | undefined): number => {
  const subscribe = useCallback((listener: () => void) => (collectionId ? subscribeCollectionFetchState(collectionId, listener) : () => {}), [collectionId]);
  const getSnapshot = useCallback(() => (collectionId ? getCollectionFetchStateVersion(collectionId) : 0), [collectionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
