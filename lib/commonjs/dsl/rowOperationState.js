"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useRowOperationState = exports.readRowOperationState = void 0;
var _react = require("react");
var _rowEquality = require("../utils/rowEquality.js");
var _configure = require("./configure.js");
const readUnsyncedChanges = (model, id) => {
  let merged;
  for (const operation of (0, _configure.getOperationState)().pendingForRow(model, id)) {
    if (operation.intent !== 'patch' || !operation.patchedValues) continue;
    merged = {
      ...(merged ?? {}),
      ...operation.patchedValues
    };
  }
  return merged;
};

/** Read the complete operation state for one row from the durable ledger. */
const readRowOperationState = (model, id) => {
  if (id == null) return {
    pending: false,
    failed: false,
    deliveryUnknown: false,
    unsyncedChanges: undefined
  };
  const key = String(id);
  const operations = (0, _configure.getOperationState)();
  return {
    pending: operations.pendingForRow(model, key).length > 0,
    failed: operations.failedFor(model, key) !== undefined,
    deliveryUnknown: operations.deliveryUnknownForRow(model, key).length > 0,
    unsyncedChanges: readUnsyncedChanges(model, key)
  };
};
exports.readRowOperationState = readRowOperationState;
const statesEqual = (left, right) => left.pending === right.pending && left.failed === right.failed && left.deliveryUnknown === right.deliveryUnknown && (left.unsyncedChanges === right.unsyncedChanges || left.unsyncedChanges !== undefined && right.unsyncedChanges !== undefined && (0, _rowEquality.rowsShallowEqual)(left.unsyncedChanges, right.unsyncedChanges));

/** Subscribe to the complete operation state for one row through one commit-bus dependency. */
const useRowOperationState = (model, id) => {
  const key = id == null ? null : String(id);
  const cacheRef = (0, _react.useRef)(undefined);
  const read = (0, _react.useCallback)(() => {
    const next = readRowOperationState(model, key);
    const previous = cacheRef.current;
    if (previous && statesEqual(previous, next)) return previous;
    cacheRef.current = next;
    return next;
  }, [key, model]);
  const subscribe = (0, _react.useCallback)(listener => {
    if (key == null) return () => {};
    const subscription = (0, _configure.getCommitBus)().subscribe(listener, [{
      kind: 'pending',
      model,
      id: key
    }]);
    return () => subscription.unsubscribe();
  }, [key, model]);
  return (0, _react.useSyncExternalStore)(subscribe, read, read);
};
exports.useRowOperationState = useRowOperationState;
//# sourceMappingURL=rowOperationState.js.map