import { useMemo, useRef } from 'react';
import type { MergeOptions } from '../types';
import { arraysShallowEqual } from './useLiveRead';

/**
 * Merges a base scope read with extra rows from a second scope read of the same model.
 * Extras whose id already exists in the base array are dropped; surviving
 * extras are appended after the base rows. When a comparator is provided the
 * merged array is sorted with it; a base-only result is resorted into a new
 * array as well (the base array itself is never mutated).
 *
 * Identity contract: when no extras survive dedup and no comparator is given,
 * the base array is returned as-is (same reference). Repeated renders with
 * referentially identical inputs return the previously built array.
 *
 * @param baseRows Base rows from the primary scope read.
 * @param extraRows Additional rows from the same model that should be merged into the base.
 * @param options Optional merge options including comparator.
 * @returns Merged rows with deduplication and optional sorting.
 */
export const useMergedScopeRows = <TRow extends { id: string }>(
  baseRows: ReadonlyArray<TRow>,
  extraRows: ReadonlyArray<TRow>,
  options?: MergeOptions<TRow>
): ReadonlyArray<TRow> => {
  const comparator = options?.comparator;
  const previousRef = useRef<{ base: ReadonlyArray<TRow>; extras: ReadonlyArray<TRow>; comparator: MergeOptions<TRow>['comparator']; result: ReadonlyArray<TRow> } | null>(null);
  return useMemo(() => {
    const previous = previousRef.current;
    if (previous && previous.base === baseRows && previous.extras === extraRows && previous.comparator === comparator) return previous.result;
    const seen = new Set(baseRows.map(row => row.id));
    const appended = extraRows.filter(row => !seen.has(row.id));
    let result: ReadonlyArray<TRow>;
    if (appended.length === 0) {
      result = comparator ? [...baseRows].sort(comparator) : baseRows;
    } else {
      const merged = [...baseRows, ...appended];
      if (comparator) merged.sort(comparator);
      result = merged;
    }
    if (previous && arraysShallowEqual(previous.result, result)) result = previous.result;
    previousRef.current = { base: baseRows, extras: extraRows, comparator, result };
    return result;
  }, [baseRows, extraRows, comparator]);
};
