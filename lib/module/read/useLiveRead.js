"use strict";

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getCommitBus } from "../dsl/configure.js";
const depsSignature = deps => deps.map(dep => dep.kind === 'model' ? `m:${dep.model}` : dep.kind === 'scope' ? `s:${dep.model}:${dep.scopeKey}` : dep.kind === 'pending' ? `p:${dep.model}:${dep.id}` : `r:${dep.model}:${dep.id}:${dep.fields?.join(',') ?? ''}`).join('|');

/** Shallow element-identity equality; rows keep stable refs in EntityState until replaced. */
export const arraysShallowEqual = (a, b) => a === b || a.length === b.length && a.every((item, index) => Object.is(item, b[index]));

/** Shallow row equality across both key sets; array values compare element identity one level deep. */
export const rowsShallowEqual = (left, right) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => {
    const leftValue = Reflect.get(left, key);
    const rightValue = Reflect.get(right, key);
    return Array.isArray(leftValue) && Array.isArray(rightValue) ? arraysShallowEqual(leftValue, rightValue) : leftValue === rightValue;
  });
};

/**
 * Reactive read primitive with pinpoint emissions: the hook subscribes to the commit bus with an
 * explicit dependency set, recomputes only when a commit batch intersects it, and re-renders only
 * when the computed value actually changed (per `isEqual`), keeping stable references otherwise.
 * Render-phase recompute happens only when the dependency signature changes; compute output must be
 * a pure function of committed DB state plus dependency-encoded inputs. Constant hook topology -
 * always the same hooks in the same order.
 */
export const useLiveRead = (compute, deps, isEqual = Object.is) => {
  const bus = getCommitBus();
  const stateRef = useRef(null);
  const subscriptionRef = useRef(null);
  if (stateRef.current === null) {
    stateRef.current = {
      value: compute(),
      version: 0,
      signature: depsSignature(deps),
      compute,
      isEqual,
      deps
    };
  }
  const state = stateRef.current;
  state.compute = compute;
  state.isEqual = isEqual;
  state.deps = deps;
  const nextSignature = depsSignature(deps);
  if (nextSignature !== state.signature) {
    state.signature = nextSignature;
    const next = compute();
    if (!state.isEqual(state.value, next)) {
      state.value = next;
      state.version += 1;
    }
  }
  const subscribe = useCallback(onStoreChange => {
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
  useEffect(() => {
    subscriptionRef.current?.setDeps(state.deps);
  });
  useSyncExternalStore(subscribe, () => state.version, () => state.version);
  return state.value;
};
//# sourceMappingURL=useLiveRead.js.map