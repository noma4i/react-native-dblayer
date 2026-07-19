'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.useIncrementalRead = exports.sortModelReadRows = exports.limitRows = exports.incrementalSignature = exports.createScopeReadEngine = exports.createModelReadEngine = void 0;
var _react = require('react');
var _configure = require('../dsl/configure.js');
var _useLiveRead = require('./useLiveRead.js');
var _normalizeHelpers = require('../utils/normalizeHelpers.js');
const identityTokens = new WeakMap();
let nextIdentityToken = 1;
const semanticValue = value => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') {
    const token = identityTokens.get(value) ?? nextIdentityToken++;
    identityTokens.set(value, token);
    return `function:${token}`;
  }
  if (Array.isArray(value)) return `[${value.map(semanticValue).join(',')}]`;
  if ((0, _normalizeHelpers.isRecord)(value)) {
    const object = value;
    const record = value;
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return `{${Object.keys(record)
        .sort()
        .map(key => `${JSON.stringify(key)}:${semanticValue(record[key])}`)
        .join(',')}}`;
    }
    const token = identityTokens.get(object) ?? nextIdentityToken++;
    identityTokens.set(object, token);
    return `object:${token}`;
  }
  return String(value);
};

/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
const incrementalSignature = (kind, ...values) => `${kind}:${values.map(semanticValue).join(':')}`;
exports.incrementalSignature = incrementalSignature;
/** Internal incremental subscription bridge. The public CommitBus contract remains unchanged. */
const useIncrementalRead = ({ signature, create, deps }) => {
  const bus = (0, _configure.getCommitBus)();
  const engineRef = (0, _react.useRef)(null);
  const subscriptionRef = (0, _react.useRef)(null);
  const generation = (0, _configure.getRuntimeGeneration)();
  if (engineRef.current === null || engineRef.current.signature !== signature || engineRef.current.generation !== generation) {
    engineRef.current = create();
  }
  const engine = engineRef.current;
  const subscribe = (0, _react.useCallback)(
    onStoreChange => {
      const subscription = bus.subscribeIncremental(
        () => onStoreChange(),
        deps,
        batch => {
          engineRef.current?.apply(batch);
        }
      );
      subscriptionRef.current = subscription;
      return () => {
        subscriptionRef.current = null;
        subscription.unsubscribe();
      };
    },
    [bus, deps]
  );
  (0, _react.useEffect)(() => {
    subscriptionRef.current?.setDeps(deps);
  });
  (0, _react.useSyncExternalStore)(
    subscribe,
    () => engine.version,
    () => engine.version
  );
  return engine.value;
};
exports.useIncrementalRead = useIncrementalRead;
const compareField = (left, right, field, direction, ordinals) => {
  const a = left[field];
  const b = right[field];
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (Object.is(a, b)) return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
  const result = a < b ? -1 : 1;
  return direction === 'asc' ? result : -result;
};

/** Sort model read results by declared keys with NULLS LAST and an implicit id tie-breaker. */
const sortModelReadRows = (rows, orderBy, limit) => {
  const sorted = [...rows].sort((left, right) => {
    for (const order of orderBy) {
      const a = left[order.field];
      const b = right[order.field];
      const aMissing = a == null;
      const bMissing = b == null;
      if (aMissing && bMissing) continue;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (Object.is(a, b)) continue;
      const result = a < b ? -1 : 1;
      return order.direction === 'asc' ? result : -result;
    }
    return left.id.localeCompare(right.id);
  });
  return limitRows(sorted, limit);
};

/** Apply an optional non-negative row limit; undefined means no limit. */
exports.sortModelReadRows = sortModelReadRows;
const limitRows = (rows, limit) => (limit === undefined ? rows : rows.slice(0, Math.max(0, limit)));
exports.limitRows = limitRows;
const engineValuesEqual = (left, right) => (Array.isArray(left) && Array.isArray(right) ? (0, _useLiveRead.arraysShallowEqual)(left, right) : Object.is(left, right));

/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
const createModelReadEngine = options => {
  const rows = options.countOnly ? null : new Map();
  const ids = new Set();
  const ordinals = new Map();
  let ordinal = 0;
  let ordered = [];
  const engine = {
    signature: options.signature,
    generation: (0, _configure.getRuntimeGeneration)(),
    value: undefined,
    version: 0,
    apply: () => false
  };
  const render = () => {
    if (rows) {
      const orderBy = options.options?.orderBy ?? [];
      const values = [...rows.values()];
      ordered = orderBy.length > 0 ? sortModelReadRows(values, orderBy, options.options?.limit) : limitRows(values, options.options?.limit);
      engine.value = options.select(ordered, ids.size);
    } else {
      engine.value = options.select([], ids.size);
    }
  };
  const rebuild = () => {
    rows?.clear();
    ids.clear();
    ordinals.clear();
    ordinal = 0;
    for (const row of options.initial()) {
      if (!options.where(row)) continue;
      ids.add(row.id);
      ordinals.set(row.id, ordinal++);
      rows?.set(row.id, row);
    }
    render();
  };
  rebuild();
  engine.apply = batch => {
    const relevant = batch?.rows.filter(change => change.model === options.model) ?? [];
    const requiresRebuild =
      batch === null ||
      batch.mode === 'bulk' ||
      batch.mode === 'replace' ||
      batch.mode === 'maintenance' ||
      batch?.maintenanceModels?.includes(options.model) === true ||
      relevant.length > 64;
    if (requiresRebuild) {
      const previous = engine.value;
      rebuild();
      if (!(options.isEqual ?? engineValuesEqual)(previous, engine.value)) engine.version += 1;
      else engine.value = previous;
      return true;
    }
    if (relevant.length === 0) return false;
    let changed = false;
    for (const change of relevant) {
      const row = options.read(change.id);
      const matched = row !== undefined && options.where(row);
      const had = ids.has(change.id);
      if (matched && !had) {
        ids.add(change.id);
        ordinals.set(change.id, ordinal++);
        rows?.set(change.id, row);
        changed = true;
      } else if (!matched && had) {
        ids.delete(change.id);
        rows?.delete(change.id);
        changed = true;
      } else if (matched && had && rows) {
        rows.set(change.id, row);
        changed = true;
      }
    }
    if (!changed) return false;
    const previous = engine.value;
    render();
    if ((options.isEqual ?? engineValuesEqual)(previous, engine.value)) {
      engine.value = previous;
      return false;
    }
    engine.version += 1;
    return true;
  };
  return engine;
};
exports.createModelReadEngine = createModelReadEngine;
/** P5 state: one scope subscription, ephemeral epochs, and conservative comparator rebuilds. */
const createScopeReadEngine = options => {
  const rows = new Map();
  const ordinals = new Map();
  let ordinal = 0;
  let windowSnapshot = null;
  const engine = {
    signature: options.signature,
    generation: (0, _configure.getRuntimeGeneration)(),
    value: [],
    version: 0,
    apply: () => false
  };
  const render = () => {
    const next = [...rows.values()];
    const sort = options.sort;
    if (sort && sort !== 'server-order') {
      if ('comparator' in sort) next.sort(sort.comparator);
      else next.sort((left, right) => compareField(left, right, sort.field, sort.direction, ordinals));
    }
    engine.value = next;
  };
  const rebuild = () => {
    rows.clear();
    ordinals.clear();
    ordinal = 0;
    for (const row of options.initial()) {
      rows.set(row.id, row);
      ordinals.set(row.id, ordinal++);
    }
    render();
  };
  const changedWindow = () => {
    if (options.windowSize === undefined) return true;
    const next = {
      rows: engine.value.slice(0, options.windowSize),
      totalCount: engine.value.length,
      hasMore: engine.value.length > options.windowSize
    };
    const changed =
      windowSnapshot === null ||
      windowSnapshot.totalCount !== next.totalCount ||
      windowSnapshot.hasMore !== next.hasMore ||
      windowSnapshot.rows.length !== next.rows.length ||
      windowSnapshot.rows.some((row, index) => row !== next.rows[index]);
    windowSnapshot = next;
    return changed;
  };
  rebuild();
  changedWindow();
  engine.apply = batch => {
    const scopeChanges = batch?.scopeChanges?.filter(change => change.model === options.model && change.scopeKey === options.scopeKey) ?? [];
    if (
      batch === null ||
      batch?.mode !== 'delta' ||
      batch.maintenanceModels?.includes(options.model) ||
      scopeChanges.some(change => change.rebuild) ||
      (options.sort && typeof options.sort !== 'string' && 'comparator' in options.sort)
    ) {
      const previous = engine.value;
      rebuild();
      if (previous !== engine.value && changedWindow()) engine.version += 1;
      return true;
    }
    if (scopeChanges.length === 0) return false;
    let changed = false;
    for (const change of scopeChanges) {
      for (const id of change.detachIds ?? []) {
        changed = rows.delete(id) || changed;
      }
      for (const id of [...(change.appendIds ?? []), ...(change.ids ?? [])]) {
        const row = options.read(id);
        if (!row) continue;
        if (!rows.has(id)) ordinals.set(id, ordinal++);
        rows.set(id, row);
        changed = true;
      }
    }
    if (!changed) return false;
    render();
    if (changedWindow()) engine.version += 1;
    return true;
  };
  return engine;
};
exports.createScopeReadEngine = createScopeReadEngine;
//# sourceMappingURL=incrementalReadEngine.js.map
