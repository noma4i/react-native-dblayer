"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useIncrementalRead = exports.sortModelReadRows = exports.limitRows = exports.incrementalSignature = exports.createModelReadEngine = void 0;
var _react = require("react");
var _configure = require("../dsl/configure.js");
var _serialize = require("../core/serialize.js");
var _ordering = require("../core/ordering.js");
var _arrayEquality = require("../utils/arrayEquality.js");
var _diagnostics = require("../core/diagnostics.js");
/** Canonical semantic descriptors preserve object identity only where leaf values require it. */
const incrementalSignature = (kind, ...values) => (0, _serialize.compositeKey)(kind, ...values.map(_serialize.semanticValue));

/** Shared React subscription harness for model and scope read engines. */
exports.incrementalSignature = incrementalSignature;
const useReadEngineHarness = ({
  signature,
  create,
  deps,
  apply,
  select,
  notifyEveryBatch = false
}) => {
  const bus = (0, _configure.getCommitBus)();
  const engineRef = (0, _react.useRef)(null);
  const subscriptionRef = (0, _react.useRef)(null);
  const applyRef = (0, _react.useRef)(apply);
  const selectRef = (0, _react.useRef)(select);
  const depsRef = (0, _react.useRef)(deps);
  applyRef.current = apply;
  selectRef.current = select;
  depsRef.current = deps;
  const generation = (0, _configure.getRuntimeGeneration)();
  if (engineRef.current === null || engineRef.current.signature !== signature || engineRef.current.generation !== generation) {
    engineRef.current = create();
  }
  // Subscription identity follows the engine identity (signature+generation), never the caller's
  // deps array literal - dep CONTENT changes flow through the live subscription via setDeps below.
  const engine = engineRef.current;
  const subscribe = (0, _react.useCallback)(onStoreChange => {
    let changed = false;
    const subscription = bus.subscribeIncremental(() => {
      if (notifyEveryBatch || changed) onStoreChange();
    }, depsRef.current, batch => {
      changed = applyRef.current(engine, batch);
    });
    subscriptionRef.current = subscription;
    return () => {
      subscriptionRef.current = null;
      subscription.unsubscribe();
    };
  }, [bus, engine, notifyEveryBatch]);
  (0, _react.useEffect)(() => {
    subscriptionRef.current?.setDeps(deps);
  });
  const snapshot = (0, _react.useCallback)(() => selectRef.current(engineRef.current), []);
  return (0, _react.useSyncExternalStore)(subscribe, snapshot, snapshot);
};

/** Internal model-read bridge over the shared engine harness. */
const useIncrementalRead = ({
  signature,
  create,
  deps
}) => {
  return useReadEngineHarness({
    signature,
    create,
    deps,
    apply: (engine, batch) => batch === null && engine.generation !== (0, _configure.getRuntimeGeneration)() ? false : engine.apply(batch),
    select: engine => engine.value
  });
};

/** Sort model read results by declared keys with NULLS LAST and an implicit locale-independent id tie-breaker. */
exports.useIncrementalRead = useIncrementalRead;
const sortModelReadRows = (rows, orderBy, limit) => {
  const sorted = [...rows].sort((0, _ordering.createFieldOrderComparator)(orderBy));
  return limitRows(sorted, limit);
};

/** Apply an optional non-negative row limit; undefined means no limit. */
exports.sortModelReadRows = sortModelReadRows;
const limitRows = (rows, limit) => limit === undefined ? rows : rows.slice(0, Math.max(0, limit));
exports.limitRows = limitRows;
const engineValuesEqual = (left, right) => Array.isArray(left) && Array.isArray(right) ? (0, _arrayEquality.arraysShallowEqual)(left, right) : Object.is(left, right);

/** P4 state: O(affected rows) delta application, with explicit rebuild fallback for bulk/reset paths. */
const createModelReadEngine = options => {
  const rows = options.countOnly ? null : new Map();
  const ids = new Set();
  let ordered = [];
  const engine = {
    signature: options.signature,
    generation: (0, _configure.getRuntimeGeneration)(),
    value: undefined,
    version: 0
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
    const initialRows = options.initial();
    (0, _diagnostics.noteReadEngineScan)(initialRows.length);
    for (const row of initialRows) {
      if (!options.where(row)) continue;
      ids.add(row.id);
      rows?.set(row.id, row);
    }
    render();
  };
  rebuild();
  engine.apply = batch => {
    const relevant = batch?.rows.filter(change => change.model === options.model) ?? [];
    const requiresRebuild = batch === null || batch.mode === 'bulk' || batch.mode === 'replace' || batch.mode === 'maintenance' || batch?.maintenanceModels?.includes(options.model) === true;
    if (requiresRebuild) {
      const previous = engine.value;
      rebuild();
      if (!(options.isEqual ?? engineValuesEqual)(previous, engine.value)) engine.version += 1;else engine.value = previous;
      (0, _diagnostics.noteReadEngineApply)('rebuild', relevant.length);
      return true;
    }
    if (relevant.length === 0) return false;
    let changed = false;
    let membershipChanged = false;
    let orderValueChanged = false;
    const orderBy = options.options?.orderBy ?? [];
    for (const change of relevant) {
      const row = options.read(change.id);
      const matched = row !== undefined && options.where(row);
      const had = ids.has(change.id);
      if (matched && !had) {
        ids.add(change.id);
        rows?.set(change.id, row);
        changed = true;
        membershipChanged = true;
      } else if (!matched && had) {
        ids.delete(change.id);
        rows?.delete(change.id);
        changed = true;
        membershipChanged = true;
      } else if (matched && had && rows) {
        rows.set(change.id, row);
        changed = true;
        const fields = change.fields;
        orderValueChanged ||= orderBy.length > 0 && (fields === null || orderBy.some(order => fields.includes(order.field)));
      }
    }
    if (!changed) {
      (0, _diagnostics.noteReadEngineApply)('delta', relevant.length);
      return false;
    }
    const previous = engine.value;
    if (rows && !membershipChanged && !orderValueChanged) {
      ordered = ordered.map(row => rows.get(row.id) ?? row);
      engine.value = options.select(ordered, ids.size);
    } else {
      render();
    }
    if ((options.isEqual ?? engineValuesEqual)(previous, engine.value)) {
      engine.value = previous;
      (0, _diagnostics.noteReadEngineApply)('delta', relevant.length);
      return false;
    }
    engine.version += 1;
    (0, _diagnostics.noteReadEngineApply)('delta', relevant.length);
    return true;
  };
  return engine;
};
exports.createModelReadEngine = createModelReadEngine;
//# sourceMappingURL=incrementalReadEngine.js.map