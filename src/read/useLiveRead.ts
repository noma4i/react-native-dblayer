import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { CommitSubscription, Dependency } from '../core/apply/commitBus';
import { getCommitBus } from '../dsl/configure';

type LiveReadState<T> = {
  value: T;
  version: number;
  compute: () => T;
  isEqual: (a: T, b: T) => boolean;
  deps: ReadonlyArray<Dependency>;
};

/** Shallow element-identity equality; rows keep stable refs in EntityState until replaced. */
export const arraysShallowEqual = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean =>
  a === b || (a.length === b.length && a.every((item, index) => Object.is(item, b[index])));

/**
 * Reactive read primitive with pinpoint emissions: the hook subscribes to the commit bus with an
 * explicit dependency set, recomputes only when a commit batch intersects it, and re-renders only
 * when the computed value actually changed (per `isEqual`), keeping stable references otherwise.
 * Constant hook topology - always the same hooks in the same order.
 */
export const useLiveRead = <T>(compute: () => T, deps: ReadonlyArray<Dependency>, isEqual: (a: T, b: T) => boolean = Object.is): T => {
  const bus = getCommitBus();
  const stateRef = useRef<LiveReadState<T> | null>(null);
  const subscriptionRef = useRef<CommitSubscription | null>(null);
  if (stateRef.current === null) {
    stateRef.current = { value: compute(), version: 0, compute, isEqual, deps };
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

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const subscription = bus.subscribe(() => {
        const recomputed = state.compute();
        if (state.isEqual(state.value, recomputed)) return;
        state.value = recomputed;
        state.version += 1;
        onStoreChange();
      }, state.deps);
      subscriptionRef.current = subscription;
      return () => {
        subscriptionRef.current = null;
        subscription.unsubscribe();
      };
    },
    [bus, state]
  );

  useEffect(() => {
    subscriptionRef.current?.setDeps(state.deps);
  });

  useSyncExternalStore(
    subscribe,
    () => state.version,
    () => state.version
  );

  return state.value;
};
