"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useIncrementalRead = exports.sortModelReadRows = exports.limitRows = exports.incrementalSignature = exports.createModelReadEngine = void 0;
var _react = require("react");
var _configure = require("../dsl/configure.js");
var _serialize = require("../core/serialize.js");
var _useLiveRead = require("./useLiveRead.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
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
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${semanticValue(record[key])}`).join(',')}}`;
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
const useIncrementalRead = ({
  signature,
  create,
  deps
}) => {
  const bus = (0, _configure.getCommitBus)();
  const engineRef = (0, _react.useRef)(null);
  const subscriptionRef = (0, _react.useRef)(null);
  const generation = (0, _configure.getRuntimeGeneration)();
  if (engineRef.current === null || engineRef.current.signature !== signature || engineRef.current.generation !== generation) {
    engineRef.current = create();
  }
  const engine = engineRef.current;
  const subscribe = (0, _react.useCallback)(onStoreChange => {
    const subscription = bus.subscribeIncremental(() => onStoreChange(), deps, batch => {
      engineRef.current?.apply(batch);
    });
    subscriptionRef.current = subscription;
    return () => {
      subscriptionRef.current = null;
      subscription.unsubscribe();
    };
  }, [bus, deps]);
  (0, _react.useEffect)(() => {
    subscriptionRef.current?.setDeps(deps);
  });
  (0, _react.useSyncExternalStore)(subscribe, () => engine.version, () => engine.version);
  return engine.value;
};
exports.useIncrementalRead = useIncrementalRead;
/** Sort model read results by declared keys with NULLS LAST and an implicit locale-independent id tie-breaker. */
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
    return (0, _serialize.compareCodepoints)(left.id, right.id);
  });
  return limitRows(sorted, limit);
};

/** Apply an optional non-negative row limit; undefined means no limit. */
exports.sortModelReadRows = sortModelReadRows;
const limitRows = (rows, limit) => limit === undefined ? rows : rows.slice(0, Math.max(0, limit));
exports.limitRows = limitRows;
const engineValuesEqual = (left, right) => Array.isArray(left) && Array.isArray(right) ? (0, _useLiveRead.arraysShallowEqual)(left, right) : Object.is(left, right);

/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
const createModelReadEngine = options => {
  const rows = options.countOnly ? null : new Map();
  const ids = new Set();
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
    for (const row of options.initial()) {
      if (!options.where(row)) continue;
      ids.add(row.id);
      rows?.set(row.id, row);
    }
    render();
  };
  rebuild();
  engine.apply = batch => {
    const relevant = batch?.rows.filter(change => change.model === options.model) ?? [];
    const requiresRebuild = batch === null || batch.mode === 'bulk' || batch.mode === 'replace' || batch.mode === 'maintenance' || batch?.maintenanceModels?.includes(options.model) === true || relevant.length > 64;
    if (requiresRebuild) {
      const previous = engine.value;
      rebuild();
      if (!(options.isEqual ?? engineValuesEqual)(previous, engine.value)) engine.version += 1;else engine.value = previous;
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
//# sourceMappingURL=incrementalReadEngine.js.map