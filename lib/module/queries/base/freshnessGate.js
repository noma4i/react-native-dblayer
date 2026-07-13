"use strict";

import { useCallback, useSyncExternalStore } from 'react';
import { getCollectionFetchStateVersion, subscribeCollectionFetchState } from "../../core/freshnessStorage.js";
import { getDbLogger } from "../../core/logger.js";

/** Freshness decision consumed by base query hooks before the initial fetch. */

/** Log one freshness skip decision for a model scope. */
export const logFreshnessSkip = (model, scopeKey, fetchState) => {
  if (!fetchState) return;
  getDbLogger().debug('db', 'freshness:skip', {
    model,
    scopeKey,
    ageMs: Date.now() - fetchState.touchedAt,
    empty: fetchState.empty
  });
};

/** Subscribe to a collection's fetch-state version, or a constant 0 when no collection is bound. */
export const useCollectionFetchStateVersion = collectionId => {
  const subscribe = useCallback(listener => collectionId ? subscribeCollectionFetchState(collectionId, listener) : () => {}, [collectionId]);
  const getSnapshot = useCallback(() => collectionId ? getCollectionFetchStateVersion(collectionId) : 0, [collectionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
//# sourceMappingURL=freshnessGate.js.map