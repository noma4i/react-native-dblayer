"use strict";

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { getCommitBus } from "../../dsl/configure.js";
import { createLiveQueryCollection, ensureMembershipCollection, ensureModelCollection, eq, registerLiveScopeReadReset } from "./facade.js";
const EMPTY_ROWS = [];
const entries = new Map();

/** Returns internal shared-live-query registry totals for contract tests. */
export function getScopeLiveReadRegistryStats() {
  return {
    entryCount: entries.size,
    refCount: [...entries.values()].reduce((count, entry) => count + entry.refCount, 0)
  };
}
const rowsEqual = (left, right) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => left[key] === right[key]);
};
const arraysEqual = (left, right) => left.length === right.length && left.every((row, index) => row === right[index]);
const plainRow = row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith(`$`)));
const updateSnapshot = entry => {
  const sourceRows = entry.liveQuery.toArray;
  const next = sourceRows.map(source => {
    const cached = entry.sourceCache.get(source);
    if (cached) return cached;
    const row = plainRow(source);
    const current = entry.rowCache.get(row.id);
    const resolved = current && rowsEqual(current, row) ? current : row;
    entry.rowCache.set(row.id, resolved);
    entry.sourceCache.set(source, resolved);
    return resolved;
  });
  if (arraysEqual(entry.snapshot, next)) {
    return;
  }
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
};
const notifyEmptyScope = entry => {
  if (entry.snapshot.length !== 0 || entry.liveQuery.toArray.length !== 0) return;
  entry.snapshot = [];
  for (const listener of entry.listeners) listener();
};
const entryKey = (modelId, scopeKey) => `${modelId}\0${scopeKey}`;
const createEntry = (modelId, scopeKey, sortMeta) => {
  const memberships = ensureMembershipCollection(modelId);
  const entities = ensureModelCollection(modelId);
  const liveQuery = createLiveQueryCollection(query => {
    const joined = query.from({
      membership: memberships
    }).where(({
      membership
    }) => eq(membership.scopeKey, scopeKey)).join({
      entity: entities
    }, ({
      membership,
      entity
    }) => eq(membership.rowId, entity.id));
    if (sortMeta.kind === `field`) {
      return joined.orderBy(({
        membership
      }) => membership.sortValue, sortMeta.dir).orderBy(({
        membership
      }) => membership.rowId).select(({
        entity
      }) => ({
        ...entity
      }));
    }
    return joined.orderBy(({
      membership
    }) => membership.seq).select(({
      entity
    }) => ({
      ...entity
    }));
  });
  const entry = {
    scopeKey,
    liveQuery,
    subscription: null,
    scopeSubscription: null,
    refCount: 0,
    snapshot: EMPTY_ROWS,
    rowCache: new Map(),
    sourceCache: new WeakMap(),
    listeners: new Set()
  };
  entry.subscription = liveQuery.subscribeChanges(() => updateSnapshot(entry));
  entry.scopeSubscription = getCommitBus().subscribeIncremental(() => notifyEmptyScope(entry), [{
    kind: `scope`,
    model: modelId,
    scopeKey
  }], () => undefined);
  updateSnapshot(entry);
  return entry;
};
const entryFor = (modelId, scopeKey, sortMeta) => {
  const key = entryKey(modelId, scopeKey);
  const current = entries.get(key);
  if (current) return current;
  const entry = createEntry(modelId, scopeKey, sortMeta);
  entries.set(key, entry);
  return entry;
};
const releaseEntry = (modelId, scopeKey, entry) => {
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.subscription.unsubscribe();
  entry.scopeSubscription.unsubscribe();
  void entry.liveQuery.cleanup();
  if (entries.get(entryKey(modelId, scopeKey)) === entry) entries.delete(entryKey(modelId, scopeKey));
};
const clearEntries = () => {
  const staleEntries = [...entries.values()];
  entries.clear();
  for (const entry of staleEntries) {
    entry.snapshot = [];
    entry.rowCache.clear();
    entry.sourceCache = new WeakMap();
    for (const listener of entry.listeners) listener();
    entry.subscription.unsubscribe();
    entry.scopeSubscription.unsubscribe();
    void entry.liveQuery.cleanup();
  }
};
registerLiveScopeReadReset(clearEntries);

/**
 * Reads one scope through a shared TanStack live query projection.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @returns Ordered stored rows with stable identities until their content changes.
 */
export function useScopeLiveRows(modelId, scopeKey, sortMeta) {
  const {
    entry,
    subscribe
  } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const getSnapshot = useCallback(() => scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot, [modelId, scopeKey, sortMeta]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Reads a stable local window from one shared TanStack live query projection.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @param windowSize Number of leading rows included in the local window.
 * @returns Stable window rows and the complete shared scope count.
 */
export function useScopeLiveWindowRows(modelId, scopeKey, sortMeta, windowSize) {
  const {
    subscribe
  } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const windowRef = useRef({
    source: EMPTY_ROWS,
    size: 0,
    snapshot: {
      rows: EMPTY_ROWS,
      totalCount: 0
    }
  });
  const getSnapshot = useCallback(() => {
    const source = scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot;
    if (windowRef.current.source === source && windowRef.current.size === windowSize) return windowRef.current.snapshot;
    const rows = source.slice(0, windowSize);
    const previous = windowRef.current.snapshot;
    if (previous.totalCount === source.length && arraysEqual(previous.rows, rows)) {
      windowRef.current = {
        source,
        size: windowSize,
        snapshot: previous
      };
      return previous;
    }
    const snapshot = {
      rows,
      totalCount: source.length
    };
    windowRef.current = {
      source,
      size: windowSize,
      snapshot
    };
    return snapshot;
  }, [modelId, scopeKey, sortMeta, windowSize]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
const useScopeLiveEntry = (modelId, scopeKey, sortMeta) => {
  const entry = scopeKey == null ? null : entryFor(modelId, scopeKey, sortMeta);
  const subscribe = useCallback(onStoreChange => {
    if (!entry || scopeKey == null) return () => undefined;
    entry.refCount += 1;
    entry.listeners.add(onStoreChange);
    return () => {
      entry.listeners.delete(onStoreChange);
      releaseEntry(modelId, scopeKey, entry);
    };
  }, [entry, modelId, scopeKey]);
  return {
    entry,
    subscribe
  };
};
//# sourceMappingURL=liveScopeReads.js.map