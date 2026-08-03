import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { RowOperationState } from '../types';
import { rowsShallowEqual } from '../utils/rowEquality';
import { getCommitBus, getOperationState } from './configure';

const readUnsyncedChanges = <TStored>(model: string, id: string): Partial<TStored> | undefined => {
  let merged: Record<string, unknown> | undefined;
  for (const operation of getOperationState().pendingForRow(model, id)) {
    if (operation.intent !== 'patch' || !operation.patchedValues) continue;
    merged = { ...(merged ?? {}), ...operation.patchedValues };
  }
  return merged as Partial<TStored> | undefined;
};

/** Read the complete operation state for one row from the durable ledger. */
export const readRowOperationState = <TStored>(model: string, id: string | null | undefined): RowOperationState<TStored> => {
  if (id == null) return { pending: false, failed: false, deliveryUnknown: false, unsyncedChanges: undefined };
  const key = String(id);
  const operations = getOperationState();
  return {
    pending: operations.pendingForRow(model, key).length > 0,
    failed: operations.failedFor(model, key) !== undefined,
    deliveryUnknown: operations.deliveryUnknownForRow(model, key).length > 0,
    unsyncedChanges: readUnsyncedChanges<TStored>(model, key)
  };
};

const statesEqual = <TStored>(left: RowOperationState<TStored>, right: RowOperationState<TStored>): boolean =>
  left.pending === right.pending &&
  left.failed === right.failed &&
  left.deliveryUnknown === right.deliveryUnknown &&
  (left.unsyncedChanges === right.unsyncedChanges ||
    (left.unsyncedChanges !== undefined && right.unsyncedChanges !== undefined && rowsShallowEqual(left.unsyncedChanges, right.unsyncedChanges)));

/** Subscribe to the complete operation state for one row through one commit-bus dependency. */
export const useRowOperationState = <TStored>(model: string, id: string | null | undefined): RowOperationState<TStored> => {
  const key = id == null ? null : String(id);
  const cacheRef = useRef<RowOperationState<TStored> | undefined>(undefined);
  const read = useCallback(() => {
    const next = readRowOperationState<TStored>(model, key);
    const previous = cacheRef.current;
    if (previous && statesEqual(previous, next)) return previous;
    cacheRef.current = next;
    return next;
  }, [key, model]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key == null) return () => {};
      const subscription = getCommitBus().subscribe(listener, [{ kind: 'pending', model, id: key }]);
      return () => subscription.unsubscribe();
    },
    [key, model]
  );
  return useSyncExternalStore(subscribe, read, read);
};
