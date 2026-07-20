"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useScopeLiveRows = useScopeLiveRows;
exports.useScopeLiveWindowRows = useScopeLiveWindowRows;
var _react = require("react");
var _configure = require("../../dsl/configure.js");
var _useLiveRead = require("../../read/useLiveRead.js");
var _projectionGate = require("../../read/projectionGate.js");
var _scopeRetention = require("../../read/scopeRetention.js");
var _facade = require("./facade.js");
const EMPTY_ROWS = [];
const entries = new Map();
const plainRow = row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith(`$`)));
const updateSnapshot = entry => {
  const sourceRows = entry.liveQuery.toArray;
  const next = sourceRows.map(source => {
    const cached = entry.sourceCache.get(source);
    if (cached) return cached;
    const row = plainRow(source);
    const current = entry.rowCache.get(row.id);
    const resolved = current && (0, _useLiveRead.rowsShallowEqual)(current, row) ? current : row;
    entry.rowCache.set(row.id, resolved);
    entry.sourceCache.set(source, resolved);
    return resolved;
  });
  if ((0, _useLiveRead.arraysShallowEqual)(entry.snapshot, next)) {
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
  const memberships = (0, _facade.ensureMembershipCollection)(modelId);
  const entities = (0, _facade.ensureModelCollection)(modelId);
  const liveQuery = (0, _facade.createLiveQueryCollection)(query => {
    const joined = query.from({
      membership: memberships
    }).where(({
      membership
    }) => (0, _facade.eq)(membership.scopeKey, scopeKey)).join({
      entity: entities
    }, ({
      membership,
      entity
    }) => (0, _facade.eq)(membership.rowId, entity.id));
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
  entry.scopeSubscription = (0, _configure.getCommitBus)().subscribeIncremental(() => notifyEmptyScope(entry), [{
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
(0, _facade.registerLiveScopeReadReset)(clearEntries);

/**
 * Reads one scope through a shared TanStack live query projection.
 *
 * @param modelId Model identifier owning the entity and membership collections.
 * @param scopeKey Serialized scope key, or `null` for the stable empty result.
 * @param sortMeta Membership sort metadata supplied by the model apply target.
 * @returns Ordered stored rows with stable identities until their content changes.
 */
function useScopeLiveRows(modelId, scopeKey, sortMeta, isResolved, options = {}) {
  (0, _projectionGate.validateProjectionOptions)(options, `${modelId}.scope.use`);
  const optionsRef = (0, _react.useRef)(options);
  const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
  const storeRef = (0, _react.useRef)({
    rows: [],
    resolved: false
  });
  const isResolvedRef = (0, _react.useRef)(isResolved);
  optionsRef.current = options;
  isResolvedRef.current = isResolved;
  const {
    entry,
    subscribe
  } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const getSnapshot = (0, _react.useCallback)(() => {
    const rows = gateRef.current.projectRows(scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot, optionsRef.current);
    const resolved = isResolvedRef.current();
    if (storeRef.current.rows === rows && storeRef.current.resolved === resolved) return storeRef.current;
    storeRef.current = {
      rows,
      resolved
    };
    return storeRef.current;
  }, [modelId, scopeKey, sortMeta]);
  const store = (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
  return (0, _scopeRetention.useScopeRetention)(scopeKey, {
    rows: store.rows,
    totalCount: store.rows.length
  }, store.resolved, options.keepPrevious === true).snapshot.rows;
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
function useScopeLiveWindowRows(modelId, scopeKey, sortMeta, windowSize, isResolved, options = {}) {
  (0, _projectionGate.validateProjectionOptions)(options, `${modelId}.scope.useWindow`);
  const optionsRef = (0, _react.useRef)(options);
  const gateRef = (0, _react.useRef)((0, _projectionGate.createProjectionGate)());
  optionsRef.current = options;
  const {
    subscribe
  } = useScopeLiveEntry(modelId, scopeKey, sortMeta);
  const isResolvedRef = (0, _react.useRef)(isResolved);
  isResolvedRef.current = isResolved;
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
  const getSnapshot = (0, _react.useCallback)(() => {
    const stored = scopeKey == null ? EMPTY_ROWS : entryFor(modelId, scopeKey, sortMeta).snapshot;
    const source = gateRef.current.projectRows(stored, optionsRef.current);
    const resolved = isResolvedRef.current();
    if (windowRef.current.source === source && windowRef.current.size === windowSize && windowRef.current.resolved === resolved) return windowRef.current.snapshot;
    const rows = source.slice(0, windowSize);
    const previous = windowRef.current.snapshot;
    if (previous.resolved === resolved && previous.totalCount === source.length && (0, _useLiveRead.arraysShallowEqual)(previous.rows, rows)) {
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
  const snapshot = (0, _react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
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
const useScopeLiveEntry = (modelId, scopeKey, sortMeta) => {
  const entry = scopeKey == null ? null : entryFor(modelId, scopeKey, sortMeta);
  const subscribe = (0, _react.useCallback)(onStoreChange => {
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