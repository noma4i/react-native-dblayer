"use strict";

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { rowsShallowEqual } from "../read/useLiveRead.js";
import { getCommitBus, getOperationState } from "./configure.js";
const readUnsyncedChanges = (model, id) => {
  let merged;
  for (const operation of getOperationState().pendingForRow(model, id)) {
    if (operation.intent !== 'patch' || !operation.patchedValues) continue;
    merged = {
      ...(merged ?? {}),
      ...operation.patchedValues
    };
  }
  return merged;
};

/** Read the complete operation state for one row from the durable ledger. */
export const readRowOperationState = (model, id) => {
  if (id == null) return {
    pending: false,
    failed: false,
    unsyncedChanges: undefined
  };
  const key = String(id);
  const operations = getOperationState();
  return {
    pending: operations.pendingForRow(model, key).length > 0,
    failed: operations.failedFor(model, key) !== undefined,
    unsyncedChanges: readUnsyncedChanges(model, key)
  };
};
const statesEqual = (left, right) => left.pending === right.pending && left.failed === right.failed && (left.unsyncedChanges === right.unsyncedChanges || left.unsyncedChanges !== undefined && right.unsyncedChanges !== undefined && rowsShallowEqual(left.unsyncedChanges, right.unsyncedChanges));

/** Subscribe to the complete operation state for one row through one commit-bus dependency. */
export const useRowOperationState = (model, id) => {
  const key = id == null ? null : String(id);
  const cacheRef = useRef(undefined);
  const read = useCallback(() => {
    const next = readRowOperationState(model, key);
    const previous = cacheRef.current;
    if (previous && statesEqual(previous, next)) return previous;
    cacheRef.current = next;
    return next;
  }, [key, model]);
  const subscribe = useCallback(listener => {
    if (key == null) return () => {};
    const subscription = getCommitBus().subscribe(listener, [{
      kind: 'pending',
      model,
      id: key
    }]);
    return () => subscription.unsubscribe();
  }, [key, model]);
  return useSyncExternalStore(subscribe, read, read);
};
//# sourceMappingURL=rowOperationState.js.map