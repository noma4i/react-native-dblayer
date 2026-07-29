"use strict";

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { getApplyTarget } from "../core/apply/applyTargetRegistry.js";
import { compareCodepoints } from "../core/serialize.js";
import { noteScopeReadPass } from "../core/diagnostics.js";
import { getCommitBus, getRuntimeGeneration } from "../dsl/configure.js";
import { storeScopeCollection } from "../core/store.js";
import { createProjectionGate, validateProjectionOptions } from "./projectionGate.js";
import { hasRequiredFields } from "./requireFields.js";
import { useScopeRetention } from "./scopeRetention.js";
import { incrementalSignature } from "./incrementalReadEngine.js";
import { rowsShallowEqual } from "./useLiveRead.js";
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
const createScopeReadEngine = (modelId, scopeKey, sortMeta) => {
  const rowCache = new Map();
  const sourceCache = new WeakMap();
  const source = scopeKey == null ? null : storeScopeCollection(modelId, scopeKey);
  let resolvedEntries = [];
  let revision = scopeKey == null ? 0 : getApplyTarget(modelId).readScopeOrderRevision(scopeKey);
  const resolveRow = (sourceRow, kind) => {
    const cached = sourceCache.get(sourceRow);
    if (cached) return cached;
    const next = Object.fromEntries(Object.entries(sourceRow).filter(([key]) => !key.startsWith('$') && key !== 'orderKey'));
    const current = rowCache.get(next.id);
    const resolved = current && rowsShallowEqual(current, next) ? current : next;
    if (resolved !== current) noteScopeReadWork(kind, 1);
    rowCache.set(next.id, resolved);
    sourceCache.set(sourceRow, resolved);
    return resolved;
  };
  const compareEntries = (left, right) => compareCodepoints(left.orderKey, right.orderKey) || compareCodepoints(left.id ?? '', right.id ?? '');
  const insertionIndex = entry => {
    let lower = 0;
    let upper = resolvedEntries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (compareEntries(resolvedEntries[middle].source, entry) < 0) lower = middle + 1;else upper = middle;
    }
    return lower;
  };
  const isScopeRow = entry => typeof entry.id === 'string' && typeof entry.orderKey === 'string';
  const updateValue = (entry, kind) => {
    if (!isScopeRow(entry)) return false;
    const currentIndex = resolvedEntries.findIndex(current => current.source.id === entry.id);
    const previous = currentIndex < 0 ? undefined : resolvedEntries[currentIndex];
    if (currentIndex >= 0) resolvedEntries.splice(currentIndex, 1);
    const nextRow = resolveRow(entry, kind);
    const nextIndex = insertionIndex(entry);
    resolvedEntries.splice(nextIndex, 0, {
      source: entry,
      row: nextRow
    });
    return previous?.source.orderKey !== entry.orderKey || previous.row !== nextRow || currentIndex !== nextIndex;
  };
  const removeValue = key => {
    const index = resolvedEntries.findIndex(entry => entry.source.id === String(key));
    if (index < 0) return false;
    const [entry] = resolvedEntries.splice(index, 1);
    rowCache.delete(entry.source.id);
    return true;
  };
  const publishRows = () => {
    engine.value = resolvedEntries.map(entry => entry.row);
    engine.version += 1;
  };
  if (source) {
    resolvedEntries = source.toArray().filter(isScopeRow).map(entry => ({
      source: entry,
      row: resolveRow(entry, 'fullRows')
    }));
  }
  const initialRows = resolvedEntries.length === 0 ? EMPTY_ROWS : resolvedEntries.map(entry => entry.row);
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
  const engine = {
    signature: incrementalSignature('scope-read', modelId, scopeKey, sortMeta),
    generation: getRuntimeGeneration(),
    value: initialRows,
    version: 0,
    subscribe: listener => {
      let notifiedSinceCommit = false;
      let forceCommitNotification = false;
      const releaseSource = source?.subscribe(changes => {
        const changed = applyChanges(changes);
        if (changed) {
          listener();
          notifiedSinceCommit = true;
        }
      }) ?? (() => {});
      if (scopeKey == null) return releaseSource;
      const subscription = getCommitBus().subscribeIncremental(() => {
        if (!notifiedSinceCommit || forceCommitNotification) listener();
        notifiedSinceCommit = false;
        forceCommitNotification = false;
      }, [{
        kind: 'scope',
        model: modelId,
        scopeKey
      }], batch => {
        if (batch === null) forceCommitNotification = reset();else {
          const nextRevision = getApplyTarget(modelId).readScopeOrderRevision(scopeKey);
          const orderChanged = nextRevision !== revision;
          revision = nextRevision;
          noteScopeReadPass(orderChanged);
        }
      });
      return () => {
        releaseSource();
        subscription.unsubscribe();
      };
    }
  };
  return engine;
};
const useScopeReadSnapshot = (modelId, scopeKey, sortMeta, snapshot) => {
  const signature = incrementalSignature('scope-read', modelId, scopeKey, sortMeta);
  const engineRef = useRef(null);
  if (!engineRef.current || engineRef.current.signature !== signature || engineRef.current.generation !== getRuntimeGeneration()) {
    engineRef.current = createScopeReadEngine(modelId, scopeKey, sortMeta);
  }
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const engine = engineRef.current;
  const subscribe = useCallback(listener => engine.subscribe(listener), [engine]);
  const getSnapshot = useCallback(() => snapshotRef.current(engine.value), [engine]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
export function useScopeReadRows(modelId, scopeKey, sortMeta, isResolved, options = {}) {
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

/** One count for one row set: the same engine source that feeds `use()`/`useWindow` (`totalCount`), so a membership without a materialized row is never counted. */
export function useScopeReadCount(modelId, scopeKey, sortMeta) {
  return useScopeReadSnapshot(modelId, scopeKey, sortMeta, rows => rows.length);
}
export function useScopeReadWindowRows(modelId, scopeKey, sortMeta, windowSize, isResolved, options = {}) {
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