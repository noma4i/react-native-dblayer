import { useRef } from 'react';
import { getRuntimeGeneration } from '../dsl/configure';

export type RetainedScopeSnapshot<T> = { rows: T[]; totalCount: number };

export type KeepPreviousOption = {
  /** Retain the prior non-empty scope key until the current key produces its first resolved snapshot. Defaults to false. */
  keepPrevious?: boolean;
};

type RetentionState<T> = {
  generation: number;
  scopeKey: string | null;
  currentResolved: boolean;
  lastNonEmpty: RetainedScopeSnapshot<T> | null;
};

/** Retain one hook's last non-empty scope snapshot only while a new key remains unresolved. */
export const useScopeRetention = <T>(
  scopeKey: string | null,
  snapshot: RetainedScopeSnapshot<T>,
  resolved: boolean,
  keepPrevious: boolean
): { snapshot: RetainedScopeSnapshot<T>; isPreviousData: boolean } => {
  const generation = getRuntimeGeneration();
  const stateRef = useRef<RetentionState<T>>({ generation, scopeKey, currentResolved: resolved, lastNonEmpty: null });
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
    return { snapshot, isPreviousData: false };
  }

  if (!keepPrevious || state.currentResolved || scopeKey == null || !state.lastNonEmpty) {
    return { snapshot, isPreviousData: false };
  }

  return { snapshot: state.lastNonEmpty, isPreviousData: true };
};
