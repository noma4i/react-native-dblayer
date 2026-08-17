import { useCallback, useRef, useSyncExternalStore } from 'react';
import { storeModelQuery } from '../core/store';
import { getCommitBus, getRuntimeGeneration } from '../dsl/configure';
import type { Dependency, ModelQueryHandle, ModelQuerySpec, RowRecord } from '../types';

/** Empty dependency set: out of every publish fanout, reachable only by `publishAll`. */
const BUS_WAKE_ONLY: ReadonlyArray<Dependency> = [];

/**
 * Read a declared model query through the collection engine. The reader holds the live query while
 * it is mounted and gives it back when it leaves, so a screen that walks through filters leaves no
 * queries behind it. A held query belongs to one runtime generation: `resetRuntime` wakes every
 * mounted reader through the commit bus, and the reader re-acquires its query from the new runtime,
 * so the first post-reset value already comes from the new generation without a remount.
 *
 * @param modelId Owning model.
 * @param key Stable identity of the declaration: same key, same live query.
 * @param spec Declared filter, order, limit and required fields.
 * @param select Projection from the query rows to the value the reader renders.
 * @param isEqual Equality that decides whether a change reaches React.
 * @returns Selected value, recomputed only when the query rows actually changed.
 */
export const useModelQuery = <TValue>(
  modelId: string,
  key: string,
  spec: ModelQuerySpec<RowRecord>,
  select: (rows: RowRecord[]) => TValue,
  isEqual: (left: TValue, right: TValue) => boolean = Object.is
): TValue => {
  const heldRef = useRef<{ key: string; generation: number; handle: ModelQueryHandle } | null>(null);
  const selectRef = useRef(select);
  const isEqualRef = useRef(isEqual);
  const specRef = useRef(spec);
  const valueRef = useRef<{ value: TValue; version: number } | null>(null);
  const renderedHandleRef = useRef<ModelQueryHandle | null>(null);
  selectRef.current = select;
  isEqualRef.current = isEqual;
  specRef.current = spec;

  const hold = useCallback((): ModelQueryHandle => {
    const generation = getRuntimeGeneration();
    const current = heldRef.current;
    if (current && current.key === key && current.generation === generation) return current.handle;
    // Releasing a handle whose store died with the previous generation is a safe no-op.
    current?.handle.release();
    const handle = storeModelQuery(modelId, key, specRef.current);
    heldRef.current = { key, generation, handle };
    return handle;
  }, [modelId, key]);
  const handle = hold();
  // The declaration or the runtime generation can change under a mounted reader: a new query means
  // a new value on this very render, not on the next change of the old one.
  const state = valueRef.current;
  // Stryker disable next-line ConditionalExpression: a null state implies a null rendered handle, so the null clause only narrows the type.
  if (state === null || renderedHandleRef.current !== handle) {
    renderedHandleRef.current = handle;
    const value = selectRef.current(handle.rows());
    valueRef.current = state === null ? { value, version: 0 } : { value, version: state.version + 1 };
  }

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let active = hold();
      const listen = (target: ModelQueryHandle): (() => void) =>
        target.subscribe(() => {
          const next = selectRef.current(target.rows());
          const current = valueRef.current!;
          if (isEqualRef.current(current.value, next)) return;
          // Stryker disable next-line ArithmeticOperator: the version must only change, not grow.
          valueRef.current = { value: next, version: current.version + 1 };
          onStoreChange();
        });
      let detach = listen(active);
      // Commits landed between the render that selected the value and this subscription are not
      // replayed by the collection: re-select once so the reader never renders a pre-gap value.
      {
        const next = selectRef.current(active.rows());
        const current = valueRef.current!;
        if (!isEqualRef.current(current.value, next)) {
          valueRef.current = { value: next, version: current.version + 1 };
          onStoreChange();
        }
      }
      // The query's own collection dies silently on reset; the bus is the reader's wake-up channel.
      // Empty deps keep this subscriber out of every publish fanout - only publishAll reaches it.
      const bus = getCommitBus().subscribe(() => {
        detach();
        active = hold();
        detach = listen(active);
        renderedHandleRef.current = active;
        const value = selectRef.current(active.rows());
        const current = valueRef.current!;
        if (isEqualRef.current(current.value, value)) return;
        // Stryker disable next-line ArithmeticOperator: the version must only change, not grow.
        valueRef.current = { value, version: current.version + 1 };
        onStoreChange();
      }, BUS_WAKE_ONLY);
      return () => {
        bus.unsubscribe();
        detach();
        heldRef.current?.handle.release();
        heldRef.current = null;
      };
    },
    // The subscription follows the query identity, never the caller's spec object literal.
    [hold]
  );

  useSyncExternalStore(subscribe, () => valueRef.current!.version);
  return valueRef.current!.value;
};
