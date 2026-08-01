"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useLiveRead = void 0;
var _react = require("react");
var _configure = require("../dsl/configure.js");
var _serialize = require("../core/serialize.js");
const depsSignature = deps => (0, _serialize.compositeKey)(...deps.map(dep => dep.kind === 'model' ? (0, _serialize.compositeKey)('m', dep.model) : dep.kind === 'scope' ? (0, _serialize.compositeKey)('s', dep.model, dep.scopeKey) : dep.kind === 'pending' ? (0, _serialize.compositeKey)('p', dep.model, dep.id) : (0, _serialize.compositeKey)('r', dep.model, dep.id, (0, _serialize.semanticValue)(dep.fields ?? []))));

/**
 * Reactive read primitive with pinpoint emissions: the hook subscribes to the commit bus with an
 * explicit dependency set, recomputes only when a commit batch intersects it, and re-renders only
 * when the computed value actually changed (per `isEqual`), keeping stable references otherwise.
 * Render-phase recompute happens only when the dependency signature changes; compute output must be
 * a pure function of committed DB state plus dependency-encoded inputs. Constant hook topology -
 * always the same hooks in the same order.
 */
const useLiveRead = (compute, deps, isEqual = Object.is, inputSignature = '') => {
  const bus = (0, _configure.getCommitBus)();
  const stateRef = (0, _react.useRef)(null);
  const subscriptionRef = (0, _react.useRef)(null);
  if (stateRef.current === null) {
    stateRef.current = {
      value: compute(),
      version: 0,
      signature: (0, _serialize.compositeKey)(inputSignature, depsSignature(deps)),
      compute,
      isEqual,
      deps
    };
  }
  const state = stateRef.current;
  state.compute = compute;
  state.isEqual = isEqual;
  state.deps = deps;
  const nextSignature = (0, _serialize.compositeKey)(inputSignature, depsSignature(deps));
  if (nextSignature !== state.signature) {
    state.signature = nextSignature;
    const next = compute();
    if (!state.isEqual(state.value, next)) {
      state.value = next;
      state.version += 1;
    }
  }
  const subscribe = (0, _react.useCallback)(onStoreChange => {
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
  }, [bus, state]);
  (0, _react.useEffect)(() => {
    subscriptionRef.current?.setDeps(state.deps);
  });
  (0, _react.useSyncExternalStore)(subscribe, () => state.version);
  return state.value;
};
exports.useLiveRead = useLiveRead;
//# sourceMappingURL=useLiveRead.js.map