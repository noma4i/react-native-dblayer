"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useScopeRetention = void 0;
var _react = require("react");
var _configure = require("../dsl/configure.js");
/** Retain one hook's last non-empty scope snapshot only while a new key remains unresolved. */
const useScopeRetention = (scopeKey, snapshot, resolved, keepPrevious) => {
  const generation = (0, _configure.getRuntimeGeneration)();
  const stateRef = (0, _react.useRef)({
    generation,
    scopeKey,
    currentResolved: resolved,
    lastNonEmpty: null
  });
  const state = stateRef.current;
  if (state.generation !== generation) {
    state.generation = generation;
    state.scopeKey = scopeKey;
    state.currentResolved = resolved;
    state.lastNonEmpty = null;
  }
  const keyChanged = state.scopeKey !== scopeKey;
  if (keyChanged) {
    state.scopeKey = scopeKey;
    state.currentResolved = resolved;
  } else if (resolved) {
    state.currentResolved = true;
  }
  if (snapshot.rows.length > 0) {
    state.currentResolved = true;
    state.lastNonEmpty = snapshot;
    return {
      snapshot,
      isPreviousData: false
    };
  }
  if (!keepPrevious || state.currentResolved || scopeKey == null || !state.lastNonEmpty) {
    return {
      snapshot,
      isPreviousData: false
    };
  }
  return {
    snapshot: state.lastNonEmpty,
    isPreviousData: true
  };
};
exports.useScopeRetention = useScopeRetention;
//# sourceMappingURL=scopeRetention.js.map