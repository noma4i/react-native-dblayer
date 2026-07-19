'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.useLiveRead = exports.rowsShallowEqual = exports.arraysShallowEqual = void 0;
var _react = require('react');
var _configure = require('../dsl/configure.js');
/** Shallow element-identity equality; rows keep stable refs in EntityState until replaced. */
const arraysShallowEqual = (a, b) => a === b || (a.length === b.length && a.every((item, index) => Object.is(item, b[index])));

/** Shallow row equality across the union of both row key sets. */
exports.arraysShallowEqual = arraysShallowEqual;
const rowsShallowEqual = (left, right) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => Reflect.get(left, key) === Reflect.get(right, key));
};

/**
 * Reactive read primitive with pinpoint emissions: the hook subscribes to the commit bus with an
 * explicit dependency set, recomputes only when a commit batch intersects it, and re-renders only
 * when the computed value actually changed (per `isEqual`), keeping stable references otherwise.
 * Constant hook topology - always the same hooks in the same order.
 */
exports.rowsShallowEqual = rowsShallowEqual;
const useLiveRead = (compute, deps, isEqual = Object.is) => {
  const bus = (0, _configure.getCommitBus)();
  const stateRef = (0, _react.useRef)(null);
  const subscriptionRef = (0, _react.useRef)(null);
  if (stateRef.current === null) {
    stateRef.current = {
      value: compute(),
      version: 0,
      compute,
      isEqual,
      deps
    };
  }
  const state = stateRef.current;
  state.compute = compute;
  state.isEqual = isEqual;
  state.deps = deps;
  const next = compute();
  if (!state.isEqual(state.value, next)) {
    state.value = next;
    state.version += 1;
  }
  const subscribe = (0, _react.useCallback)(
    onStoreChange => {
      const subscription = bus.subscribe(() => {
        const recomputed = state.compute();
        if (state.isEqual(state.value, recomputed)) return;
        state.value = recomputed;
        state.version += 1;
        onStoreChange();
      }, state.deps);
      subscriptionRef.current = subscription;
      const recomputed = state.compute();
      if (!state.isEqual(state.value, recomputed)) {
        state.value = recomputed;
        state.version += 1;
        onStoreChange();
      }
      return () => {
        subscriptionRef.current = null;
        subscription.unsubscribe();
      };
    },
    [bus, state]
  );
  (0, _react.useEffect)(() => {
    subscriptionRef.current?.setDeps(state.deps);
  });
  (0, _react.useSyncExternalStore)(
    subscribe,
    () => state.version,
    () => state.version
  );
  return state.value;
};
exports.useLiveRead = useLiveRead;
//# sourceMappingURL=useLiveRead.js.map
