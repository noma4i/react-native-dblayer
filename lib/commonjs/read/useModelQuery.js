"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useModelQuery = void 0;
var _react = require("react");
var _store = require("../core/store.js");
/**
 * Read a declared model query through the collection engine. The reader holds the live query while
 * it is mounted and gives it back when it leaves, so a screen that walks through filters leaves no
 * queries behind it.
 *
 * @param modelId Owning model.
 * @param key Stable identity of the declaration: same key, same live query.
 * @param spec Declared filter, order, limit and required fields.
 * @param select Projection from the query rows to the value the reader renders.
 * @param isEqual Equality that decides whether a change reaches React.
 * @returns Selected value, recomputed only when the query rows actually changed.
 */
const useModelQuery = (modelId, key, spec, select, isEqual = Object.is) => {
  const heldRef = (0, _react.useRef)(null);
  const selectRef = (0, _react.useRef)(select);
  const isEqualRef = (0, _react.useRef)(isEqual);
  const specRef = (0, _react.useRef)(spec);
  const valueRef = (0, _react.useRef)(null);
  const renderedKeyRef = (0, _react.useRef)(null);
  selectRef.current = select;
  isEqualRef.current = isEqual;
  specRef.current = spec;
  const hold = (0, _react.useCallback)(() => {
    const current = heldRef.current;
    if (current && current.key === key) return current.handle;
    current?.handle.release();
    const handle = (0, _store.storeModelQuery)(modelId, key, specRef.current);
    heldRef.current = {
      key,
      handle
    };
    return handle;
  }, [modelId, key]);
  const handle = hold();
  // The declaration can change under a mounted reader: a new query means a new value on this very
  // render, not on the next change of the old one.
  const state = valueRef.current;
  if (state === null || heldRef.current.key !== renderedKeyRef.current) {
    renderedKeyRef.current = key;
    const value = selectRef.current(handle.rows());
    valueRef.current = state === null ? {
      value,
      version: 0
    } : {
      value,
      version: state.version + 1
    };
  }
  const subscribe = (0, _react.useCallback)(onStoreChange => {
    const active = hold();
    const unsubscribe = active.subscribe(() => {
      const next = selectRef.current(active.rows());
      const state = valueRef.current;
      if (isEqualRef.current(state.value, next)) return;
      valueRef.current = {
        value: next,
        version: state.version + 1
      };
      onStoreChange();
    });
    return () => {
      unsubscribe();
      heldRef.current?.handle.release();
      heldRef.current = null;
    };
  },
  // The subscription follows the query identity, never the caller's spec object literal.
  [hold]);
  (0, _react.useSyncExternalStore)(subscribe, () => valueRef.current.version);
  return valueRef.current.value;
};
exports.useModelQuery = useModelQuery;
//# sourceMappingURL=useModelQuery.js.map