"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useScopeReadCount = useScopeReadCount;
exports.useScopeReadRows = useScopeReadRows;
exports.useScopeReadWindowRows = useScopeReadWindowRows;
var _react = require("react");
var _applyTargetRegistry = require("../core/apply/applyTargetRegistry.js");
var _serialize = require("../core/serialize.js");
var _diagnostics = require("../core/diagnostics.js");
var _configure = require("../dsl/configure.js");
var _store = require("../core/store.js");
var _projectionGate = require("./projectionGate.js");
var _requireFields = require("./requireFields.js");
var _scopeRetention = require("./scopeRetention.js");
var _readIdentity = require("./readIdentity.js");
var _rowEquality = require("../utils/rowEquality.js");
var _arrayEquality = require("../utils/arrayEquality.js");
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
  const filtered = rows.filter(row => (0, _requireFields.hasRequiredFields)(row, require));
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
  const source = scopeKey == null ? null : (0, _store.storeScopeCollection)(modelId, scopeKey);
  let resolvedEntries = [];
  let revision = scopeKey == null ? 0 : (0, _applyTargetRegistry.getApplyTarget)(modelId).readScopeOrderRevision(scopeKey);
  // The declared sort is the order authority for a client-sorted scope; persisted
  // entry order carries the order only for server-order scopes.
  const rowCompare = scopeKey == null ? null : (0, _applyTargetRegistry.getApplyTarget)(modelId).compareScopeRows(scopeKey);
  const resolveRow = (sourceRow, kind) => {
    const next = Object.fromEntries(Object.entries(sourceRow).filter(([key]) => !key.startsWith('$') && key !== 'orderKey'));
    const current = rowCache.get(next.id);
    const resolved = current && (0, _rowEquality.rowsShallowEqual)(current, next) ? current : next;
    if (resolved !== current) noteScopeReadWork(kind, 1);
    rowCache.set(next.id, resolved);
    return resolved;
  };
  const compareEntries = (left, right) => rowCompare ? rowCompare(left.row, right.row) : (0, _serialize.compareCodepoints)(left.source.orderKey, right.source.orderKey) || (0, _serialize.compareCodepoints)(left.source.id, right.source.id);
  const insertionIndex = entry => {
    let lower = 0;
    let upper = resolvedEntries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (compareEntries(resolvedEntries[middle], entry) < 0) lower = middle + 1;else upper = middle;
    }
    return lower;
  };
  const isScopeRow = entry => typeof entry.id === 'string' && typeof entry.orderKey === 'string';
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
  const publishRows = () => {
    engine.value = resolvedEntries.map(entry => entry.row);
    engine.version += 1;
  };
  const readSource = () => {
    if (!source) return [];
    const entries = source.toArray().filter(isScopeRow).map(entry => ({
      source: entry,
      row: resolveRow(entry, 'fullRows')
    }));
    if (rowCompare) entries.sort(compareEntries);
    return entries;
  };
  resolvedEntries = readSource();
  const initialRows = resolvedEntries.length === 0 ? EMPTY_ROWS : resolvedEntries.map(entry => entry.row);
  const sameEntries = (left, right) => left.length === right.length && left.every((entry, index) => entry.source.id === right[index].source.id && entry.source.orderKey === right[index].source.orderKey && entry.row === right[index].row);
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
    signature: (0, _readIdentity.incrementalSignature)('scope-read', modelId, scopeKey, sortMeta),
    generation: (0, _configure.getRuntimeGeneration)(),
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
      // The snapshot was taken at render; commits landed before this subscription attached are not
      // delivered as changes, so the engine re-reads the source once and publishes the difference.
      const current = readSource();
      if (!sameEntries(resolvedEntries, current)) {
        resolvedEntries = current;
        publishRows();
      }
      if (scopeKey == null) return releaseSource;
      const subscription = (0, _configure.getCommitBus)().subscribeIncremental(() => {
        if (!notifiedSinceCommit || forceCommitNotification) listener();
        notifiedSinceCommit = false;
        forceCommitNotification = false;
      }, [{
        kind: 'scope',
        model: modelId,
        scopeKey
      }], batch => {
        if (batch === null) forceCommitNotification = reset();else {
          // Not duplication of engine state: the revision comparison feeds the scopeReadPasses/scopeReadResorts
          // work counters that the p04/p06 perf gates assert on (resorts must stay scope-local).
          const nextRevision = (0, _applyTargetRegistry.getApplyTarget)(modelId).readScopeOrderRevision(scopeKey);
          const orderChanged = nextRevision !== revision;
          revision = nextRevision;
          (0, _diagnostics.noteScopeReadPass)(orderChanged);
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
  const signature = (0, _readIdentity.incrementalSignature)('scope-read', modelId, scopeKey, sortMeta);
  const engineRef = (0, _react.useRef)(null);
  if (!engineRef.current || engineRef.current.signature !== signature || engineRef.current.generation !== (0, _configure.getRuntimeGeneration)()) {
    engineRef.current = createScopeReadEngine(modelId, scopeKey, sortMeta);
  }
  const snapshotRef = (0, _react.useRef)(snapshot);
  snapshotRef.current = snapshot;
  const engine = engineRef.current;
  const subscribe = (0, _react.useCallback)(listener => engine.subscribe(listener), [engine]);
  const getSnapshot = (0, _react.useCallback)(() => snapshotRef.current(engine.value), [engine]);
  return (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
};
function useScopeReadRows(modelId, scopeKey, sortMeta, isResolved, options) {
  (0, _projectionGate.validateProjectionOptions)(options, `${modelId}.scope.use`);
  const optionsRef = (0, _react.useRef)(options);
  const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
  const storeRef = (0, _react.useRef)({
    rows: [],
    resolved: false
  });
  const requireGateRef = (0, _react.useRef)({
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
  return (0, _scopeRetention.useScopeRetention)(scopeKey, {
    rows: store.rows,
    totalCount: store.rows.length
  }, store.resolved, options.keepPrevious === true).snapshot.rows;
}

/** One count for one row set: the same engine source that feeds `use()`/`useWindow` (`totalCount`), so a membership without a materialized row is never counted. */
function useScopeReadCount(modelId, scopeKey, sortMeta, isResolved) {
  // The resolved flip is the snapshot's witness of a new runtime generation: a bare length stays 0
  // across a reset of an empty scope, and a snapshot that never changes never re-renders the reader.
  const storeRef = (0, _react.useRef)(null);
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
function useScopeReadWindowRows(modelId, scopeKey, sortMeta, windowSize, isResolved, options) {
  (0, _projectionGate.validateProjectionOptions)(options, `${modelId}.scope.useWindow`);
  const optionsRef = (0, _react.useRef)(options);
  const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
  const requireGateRef = (0, _react.useRef)({
    source: null,
    require: undefined,
    result: EMPTY_ROWS
  });
  const windowRef = (0, _react.useRef)({
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
    const next = previous.resolved === resolved && previous.totalCount === source.length && (0, _arrayEquality.arraysShallowEqual)(previous.rows, rows) ? previous : {
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
  const retained = (0, _scopeRetention.useScopeRetention)(scopeKey, snapshot, snapshot.resolved, options.keepPrevious === true);
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