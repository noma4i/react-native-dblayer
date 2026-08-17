"use strict";

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { getApplyTarget } from "../core/apply/applyTargetRegistry.js";
import { compareCodepoints } from "../core/serialize.js";
import { noteScopeReadPass } from "../core/diagnostics.js";
import { getCommitBus, getRuntimeGeneration } from "../dsl/configure.js";
import { storeScopeCollection } from "../core/store.js";
import { createDerivedCollectionCache } from "../core/storeDerivedCollections.js";
import { registerReset } from "../core/reset.js";
import { createProjectionGate, validateProjectionOptions } from "./projectionGate.js";
import { hasRequiredFields } from "./requireFields.js";
import { useScopeRetention } from "./scopeRetention.js";
import { incrementalSignature } from "./readIdentity.js";
import { rowsShallowEqual } from "../utils/rowEquality.js";
import { arraysShallowEqual } from "../utils/arrayEquality.js";
const EMPTY_ROWS = [];
const scopeReadWork = {
  fullRows: 0,
  incrementalRows: 0
};
const scopeReadWorkGlobal = {
  snapshot: () => ({
    ...scopeReadWork
  }),
  reset: () => {
    scopeReadWork.fullRows = 0;
    scopeReadWork.incrementalRows = 0;
  }
};
globalThis.__DBLAYER_SCOPE_READ_WORK__ = scopeReadWorkGlobal;
const noteScopeReadWork = (kind, count) => {
  scopeReadWork[kind] += count;
};
const requireFilteredRows = (rows, require) => {
  if (!require || require.length === 0) return rows;
  const filtered = rows.filter(row => hasRequiredFields(row, require));
  return filtered.length === rows.length ? rows : filtered;
};
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
const isScopeRow = entry => typeof entry.id === 'string' && typeof entry.orderKey === 'string';
const stripEngineFields = sourceRow => Object.fromEntries(Object.entries(sourceRow).filter(([key]) => !key.startsWith('$') && key !== 'orderKey'));

/**
 * One materialization of a scope per key: the ordered rows every reader of the key shares. The
 * holder is subscribed to the store collection from the moment it exists, so its value is never
 * older than the last commit while any reader holds it; readers read `value`, they never keep a
 * copy of the rows.
 */
const createScopeReadHolder = (modelId, scopeKey, seed) => {
  const rowCache = new Map();
  const source = storeScopeCollection(modelId, scopeKey);
  const listeners = new Set();
  let resolvedEntries = [];
  let revision = getApplyTarget(modelId).readScopeOrderRevision(scopeKey);
  // The declared sort is the order authority for a client-sorted scope; persisted
  // entry order carries the order only for server-order scopes.
  const rowCompare = getApplyTarget(modelId).compareScopeRows(scopeKey);
  const resolveRow = (sourceRow, kind) => {
    const next = stripEngineFields(sourceRow);
    const current = rowCache.get(next.id);
    const resolved = current && rowsShallowEqual(current, next) ? current : next;
    if (resolved !== current) noteScopeReadWork(kind, 1);
    rowCache.set(next.id, resolved);
    return resolved;
  };
  const compareEntries = (left, right) => rowCompare ? rowCompare(left.row, right.row) : compareCodepoints(left.source.orderKey, right.source.orderKey) || compareCodepoints(left.source.id, right.source.id);
  const insertionIndex = entry => {
    let lower = 0;
    let upper = resolvedEntries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (compareEntries(resolvedEntries[middle], entry) < 0) lower = middle + 1;else upper = middle;
    }
    return lower;
  };
  const readSource = () => {
    const entries = source.toArray().filter(isScopeRow).map(entry => ({
      source: entry,
      row: resolveRow(entry, 'fullRows')
    }));
    if (rowCompare) entries.sort(compareEntries);
    return entries;
  };
  const publishRows = () => {
    holder.value = resolvedEntries.length === 0 ? EMPTY_ROWS : resolvedEntries.map(entry => entry.row);
  };
  const updateValue = (entry, kind) => {
    if (!isScopeRow(entry)) return false;
    const currentIndex = resolvedEntries.findIndex(current => current.source.id === entry.id);
    const previous = currentIndex < 0 ? undefined : resolvedEntries[currentIndex];
    if (currentIndex >= 0) resolvedEntries.splice(currentIndex, 1);
    const resolved = {
      source: entry,
      row: resolveRow(entry, kind)
    };
    const nextIndex = insertionIndex(resolved);
    resolvedEntries.splice(nextIndex, 0, resolved);
    return previous?.source.orderKey !== entry.orderKey || previous.row !== resolved.row;
  };
  const removeValue = key => {
    const index = resolvedEntries.findIndex(entry => entry.source.id === String(key));
    if (index < 0) return false;
    const [entry] = resolvedEntries.splice(index, 1);
    rowCache.delete(entry.source.id);
    return true;
  };
  const applyChanges = changes => {
    let changed = false;
    for (const change of changes) {
      const didChange = change.type === 'delete' ? removeValue(change.key) : updateValue(change.value, 'incrementalRows');
      changed ||= didChange;
    }
    if (changed) publishRows();
    return changed;
  };
  const reset = () => {
    if (resolvedEntries.length === 0) return false;
    rowCache.clear();
    resolvedEntries = [];
    publishRows();
    return true;
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  // Seed identity: a reader that rendered before this holder existed passes the rows it rendered;
  // when the source still names the same rows the holder adopts them and the reader does not
  // re-render on subscribe.
  if (seed) for (const row of seed) rowCache.set(row.id, row);
  resolvedEntries = readSource();
  const holder = {
    value: EMPTY_ROWS,
    listen: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cleanup: () => {
      releaseSource();
      commitSubscription.unsubscribe();
      listeners.clear();
    }
  };
  publishRows();
  if (seed && holder.value.length === seed.length && holder.value.every((row, index) => row === seed[index])) holder.value = seed;
  let notifiedSinceCommit = false;
  let forceCommitNotification = false;
  const releaseSource = source.subscribe(changes => {
    if (applyChanges(changes)) {
      notify();
      notifiedSinceCommit = true;
    }
  });
  const commitSubscription = getCommitBus().subscribeIncremental(() => {
    if (!notifiedSinceCommit || forceCommitNotification) notify();
    notifiedSinceCommit = false;
    forceCommitNotification = false;
  }, [{
    kind: 'scope',
    model: modelId,
    scopeKey
  }], batch => {
    if (batch === null) forceCommitNotification = reset();else {
      // Not duplication of holder state: the revision comparison feeds the scopeReadPasses/scopeReadResorts
      // work counters that the p04/p06 perf gates assert on (resorts must stay scope-local).
      const nextRevision = getApplyTarget(modelId).readScopeOrderRevision(scopeKey);
      const orderChanged = nextRevision !== revision;
      revision = nextRevision;
      noteScopeReadPass(orderChanged);
    }
  });
  return holder;
};
/**
 * Process-wide holder cache: one holder per key while any reader holds it. A runtime reset does not
 * dispose holders: the key carries the generation, so `publishAll` after the reset re-renders every
 * reader onto a new-generation holder and the last release retires the old one.
 */
const holders = createDerivedCollectionCache('scopeReadHolders');
const holderKey = (modelId, scopeKey, sortMeta) => incrementalSignature('scope-read', modelId, scopeKey, sortMeta) + `|g${getRuntimeGeneration()}`;

/**
 * Rows a reader rendered before it attached, per key: every reader of the key that renders before the
 * holder exists shares these row identities, and the holder adopts them when it is created.
 */
const seeds = new Map();
registerReset(() => seeds.clear());

/** An ordered read of the source for a reader that has not attached yet: React re-reads through the holder right after subscribe. */
const readSeed = (key, modelId, scopeKey) => {
  const previous = seeds.get(key);
  const previousById = new Map(previous?.map(row => [row.id, row]));
  const rowCompare = getApplyTarget(modelId).compareScopeRows(scopeKey);
  const entries = storeScopeCollection(modelId, scopeKey).toArray().filter(isScopeRow).map(entry => {
    const next = stripEngineFields(entry);
    const known = previousById.get(next.id);
    const row = known && rowsShallowEqual(known, next) ? known : next;
    if (row !== known) noteScopeReadWork('fullRows', 1);
    return {
      source: entry,
      row
    };
  });
  if (rowCompare) entries.sort((left, right) => rowCompare(left.row, right.row));else entries.sort((left, right) => compareCodepoints(left.source.orderKey, right.source.orderKey) || compareCodepoints(left.source.id, right.source.id));
  const rows = entries.length === 0 ? EMPTY_ROWS : entries.map(entry => entry.row);
  const same = previous !== undefined && previous.length === rows.length && rows.every((row, index) => row === previous[index]);
  if (same) return previous;
  seeds.set(key, rows);
  return rows;
};
const acquireHolder = (key, modelId, scopeKey) => holders.acquire(key, () => {
  const seed = seeds.get(key) ?? null;
  seeds.delete(key);
  return createScopeReadHolder(modelId, scopeKey, seed);
});
const useScopeReadSnapshot = (modelId, scopeKey, sortMeta, snapshot) => {
  const key = scopeKey === null ? null : holderKey(modelId, scopeKey, sortMeta);
  const heldRef = useRef(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const subscribe = useCallback(listener => {
    if (key === null || scopeKey === null) return () => {};
    const held = acquireHolder(key, modelId, scopeKey);
    heldRef.current = {
      key,
      holder: held.collection
    };
    const unlisten = held.collection.listen(listener);
    return () => {
      unlisten();
      if (heldRef.current?.holder === held.collection) heldRef.current = null;
      held.release();
    };
  }, [key, modelId, scopeKey]);
  const getSnapshot = useCallback(() => {
    if (key === null || scopeKey === null) return snapshotRef.current(EMPTY_ROWS);
    if (heldRef.current?.key === key) return snapshotRef.current(heldRef.current.holder.value);
    return snapshotRef.current(readSeed(key, modelId, scopeKey));
  }, [key, modelId, scopeKey]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
export function useScopeReadRows(modelId, scopeKey, sortMeta, isResolved, options) {
  validateProjectionOptions(options, `${modelId}.scope.use`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate());
  const storeRef = useRef({
    rows: [],
    resolved: false
  });
  const requireGateRef = useRef({
    source: null,
    require: undefined,
    result: EMPTY_ROWS
  });
  optionsRef.current = options;
  const store = useScopeReadSnapshot(modelId, scopeKey, sortMeta, source => {
    const rows = gateRef.current.projectRows(readRequireGate(requireGateRef, source, optionsRef.current.require), optionsRef.current);
    const resolved = isResolved();
    if (storeRef.current.rows === rows && storeRef.current.resolved === resolved) return storeRef.current;
    storeRef.current = {
      rows,
      resolved
    };
    return storeRef.current;
  });
  return useScopeRetention(scopeKey, {
    rows: store.rows,
    totalCount: store.rows.length
  }, store.resolved, options.keepPrevious === true).snapshot.rows;
}

/** One count for one row set: the same holder that feeds `use()`/`useWindow` (`totalCount`), so a membership without a materialized row is never counted. */
export function useScopeReadCount(modelId, scopeKey, sortMeta, isResolved) {
  // The resolved flip is the snapshot's witness of a new runtime generation: a bare length stays 0
  // across a reset of an empty scope, and a snapshot that never changes never re-renders the reader.
  const storeRef = useRef(null);
  const store = useScopeReadSnapshot(modelId, scopeKey, sortMeta, rows => {
    const resolved = isResolved();
    const current = storeRef.current;
    if (current && current.count === rows.length && current.resolved === resolved) return current;
    storeRef.current = {
      count: rows.length,
      resolved
    };
    return storeRef.current;
  });
  return store.count;
}
export function useScopeReadWindowRows(modelId, scopeKey, sortMeta, windowSize, isResolved, options) {
  validateProjectionOptions(options, `${modelId}.scope.useWindow`);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate());
  const requireGateRef = useRef({
    source: null,
    require: undefined,
    result: EMPTY_ROWS
  });
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
  optionsRef.current = options;
  const snapshot = useScopeReadSnapshot(modelId, scopeKey, sortMeta, stored => {
    const source = gateRef.current.projectRows(readRequireGate(requireGateRef, stored, optionsRef.current.require), optionsRef.current);
    const resolved = isResolved();
    if (windowRef.current.source === source && windowRef.current.size === windowSize && windowRef.current.resolved === resolved) return windowRef.current.snapshot;
    const rows = source.slice(0, windowSize);
    const previous = windowRef.current.snapshot;
    const next = previous.resolved === resolved && previous.totalCount === source.length && arraysShallowEqual(previous.rows, rows) ? previous : {
      rows,
      totalCount: source.length,
      isPreviousData: false,
      resolved
    };
    windowRef.current = {
      source,
      size: windowSize,
      resolved,
      snapshot: next
    };
    return next;
  });
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
//# sourceMappingURL=scopeReadEngine.js.map