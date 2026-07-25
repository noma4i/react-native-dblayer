"use strict";

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { getCommitBus } from "../../dsl/configure.js";
import { compositeKey } from "../serialize.js";
import { arraysShallowEqual, rowsShallowEqual } from "../../read/useLiveRead.js";
import { createProjectionGate, validateProjectionOptions } from "../../read/projectionGate.js";
import { hasRequiredFields } from "../../read/requireFields.js";
import { useScopeRetention } from "../../read/scopeRetention.js";
import { createLiveQueryCollection, ensureMembershipCollection, ensureModelCollection, eq, registerLiveScopeReadReset } from "./facade.js";
const EMPTY_ROWS = [];
const entries = new Map();

/** Filters a scope snapshot down to rows satisfying `require`, returning the SAME array reference when nothing is filtered out. */
const requireFilteredRows = (rows, require) => {
  if (!require || require.length === 0) return rows;
  const filtered = rows.filter(row => hasRequiredFields(row, require));
  return filtered.length === rows.length ? rows : filtered;
};
/** Per-hook memo over `requireFilteredRows`: skips the O(N) filter pass entirely when both the source snapshot and the `require` list are referentially unchanged since the last call. */
const readRequireGate = (cache, source, require) => {
  const current = cache.current;
  if (current.source === source && current.require === require) return current.result;
  const result = requireFilteredRows(source, require);
  cache.current = {
    source,
    require,
    result
  };
  return result;
};
const plainRow = row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith(`$`)));
const updateSnapshot = entry => {
  const sourceRows = entry.liveQuery.toArray;
  const next = sourceRows.map(source => {
    const cached = entry.sourceCache.get(source);
    if (cached) return cached;
    const row = plainRow(source);
    const current = entry.rowCache.get(row.id);
    const resolved = current && rowsShallowEqual(current, row) ? current : row;
    entry.rowCache.set(row.id, resolved);
    entry.sourceCache.set(source, resolved);
    return resolved;
  });
  if (arraysShallowEqual(entry.snapshot, next)) {
    return;
  }
  entry.snapshot = next;
  if (entry.rowCache.size > next.length) {
    const liveIds = new Set(next.map(row => row.id));
    for (const id of entry.rowCache.keys()) {
      if (!liveIds.has(id)) entry.rowCache.delete(id);
    }
  }
  for (const listener of entry.listeners) listener();
};
const notifyEmptyScope = entry => {
  if (entry.snapshot.length !== 0 || entry.liveQuery.toArray.length !== 0) return;
  entry.snapshot = [];
  for (const listener of entry.listeners) listener();
};
const entryKey = (modelId, scopeKey) => compositeKey(modelId, scopeKey);
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
      }) => membership.sortValue, {
        direction: sortMeta.dir,
        nulls: `last`
      }).orderBy(({
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
  entry.subscription?.unsubscribe();
  entry.scopeSubscription?.unsubscribe();
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
    entry.subscription?.unsubscribe();
    entry.scopeSubscription?.unsubscribe();
    void entry.liveQuery.cleanup();
  }
};
registerLiveScopeReadReset(clearEntries);

/**
 * Reads one scope through a shared TanStack live query projection.
 *
 * `options.require` is a render-completeness contract: a row transiently missing one of those fields
 * (mid sideload/partial write, before the full row lands) is held back rather than handed to a
 * consumer that assumes the field is guaranteed. It reappears in this same read, through the same
 * snapshot/subscription path, the moment the missing field commits - no separate fetch or remount.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @returns Ordered stored rows with stable identities until their content changes.
 */
export function useScopeLiveRows(modelId, scopeKey, sortMeta, isResolved, options = {}) {
  validateProjectionOptions(options, `${modelId}.scope.use`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate());
  const storeRef = useRef({
    rows: [],
    resolved: false
  });
  const isResolvedRef = useRef(isResolved);
  const requireGateRef = useRef({
    source: null,
    require: undefined,
    result: EMPTY_ROWS
  });
  optionsRef.current = options;
  isResolvedRef.current = isResolved;
  const {
    entry,
    subscribe
  } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const getSnapshot = useCallback(() => {
    const stored = scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot;
    const gated = readRequireGate(requireGateRef, stored, optionsRef.current.require);
    const rows = gateRef.current.projectRows(gated, optionsRef.current);
    const resolved = isResolvedRef.current();
    if (storeRef.current.rows === rows && storeRef.current.resolved === resolved) return storeRef.current;
    storeRef.current = {
      rows,
      resolved
    };
    return storeRef.current;
  }, [modelId, scopeKey, sortMeta]);
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useScopeRetention(scopeKey, {
    rows: store.rows,
    totalCount: store.rows.length
  }, store.resolved, options.keepPrevious === true).snapshot.rows;
}

/**
 * Reads a stable local window from one shared TanStack live query projection.
 *
 * `options.require` gates rows the same way as `useScopeLiveRows` - a row missing a required field is
 * excluded before windowing, so `totalCount`/`hasMore` reflect the filtered set (a transiently partial
 * row never opens a hole in pagination), and it reappears once the field lands.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @param windowSize Number of leading rows included in the local window.
 * @returns Stable window rows and the complete shared scope count.
 */
export function useScopeLiveWindowRows(modelId, scopeKey, sortMeta, windowSize, isResolved, options = {}) {
  validateProjectionOptions(options, `${modelId}.scope.useWindow`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate());
  const requireGateRef = useRef({
    source: null,
    require: undefined,
    result: EMPTY_ROWS
  });
  optionsRef.current = options;
  const {
    subscribe
  } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const isResolvedRef = useRef(isResolved);
  isResolvedRef.current = isResolved;
  const windowRef = useRef({
    source: EMPTY_ROWS,
    size: 0,
    resolved: false,
    snapshot: {
      rows: EMPTY_ROWS,
      totalCount: 0,
      isPreviousData: false,
      resolved: false
    }
  });
  const getSnapshot = useCallback(() => {
    const stored = scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot;
    const gated = readRequireGate(requireGateRef, stored, optionsRef.current.require);
    const source = gateRef.current.projectRows(gated, optionsRef.current);
    const resolved = isResolvedRef.current();
    if (windowRef.current.source === source && windowRef.current.size === windowSize && windowRef.current.resolved === resolved) return windowRef.current.snapshot;
    const rows = source.slice(0, windowSize);
    const previous = windowRef.current.snapshot;
    if (previous.resolved === resolved && previous.totalCount === source.length && arraysShallowEqual(previous.rows, rows)) {
      windowRef.current = {
        source,
        size: windowSize,
        resolved,
        snapshot: previous
      };
      return previous;
    }
    const snapshot = {
      rows,
      totalCount: source.length,
      isPreviousData: false,
      resolved
    };
    windowRef.current = {
      source,
      size: windowSize,
      resolved,
      snapshot
    };
    return snapshot;
  }, [modelId, scopeKey, sortMeta, windowSize]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const retained = useScopeRetention(scopeKey, snapshot, snapshot.resolved, options.keepPrevious === true);
  return retained.snapshot === snapshot ? {
    rows: snapshot.rows,
    totalCount: snapshot.totalCount,
    isPreviousData: false,
    resolved: snapshot.resolved
  } : {
    ...retained.snapshot,
    isPreviousData: retained.isPreviousData,
    resolved: snapshot.resolved
  };
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