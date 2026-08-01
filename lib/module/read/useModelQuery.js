"use strict";

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { storeModelQuery } from "../core/store.js";
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
export const useModelQuery = (modelId, key, spec, select, isEqual = Object.is) => {
  const heldRef = useRef(null);
  const selectRef = useRef(select);
  const isEqualRef = useRef(isEqual);
  const specRef = useRef(spec);
  const valueRef = useRef(null);
  selectRef.current = select;
  isEqualRef.current = isEqual;
  specRef.current = spec;
  const hold = useCallback(() => {
    const current = heldRef.current;
    if (current && current.key === key) return current.handle;
    current?.handle.release();
    const handle = storeModelQuery(modelId, key, specRef.current);
    heldRef.current = {
      key,
      handle
    };
    return handle;
  }, [modelId, key]);
  const handle = hold();
  valueRef.current ??= {
    value: selectRef.current(handle.rows()),
    version: 0
  };
  const subscribe = useCallback(onStoreChange => {
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
  useSyncExternalStore(subscribe, () => valueRef.current.version);
  return valueRef.current.value;
};
//# sourceMappingURL=useModelQuery.js.map