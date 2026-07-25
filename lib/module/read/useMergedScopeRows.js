"use strict";

import { useMemo, useRef } from 'react';
import { arraysShallowEqual } from "./useLiveRead.js";
/**
 * Merges a base scope read with extra rows from a second scope read.
 * Extras whose id already exists in the base array are dropped; surviving
 * extras are appended after the base rows. When a comparator is provided the
 * merged array is sorted with it; a base-only result is resorted into a new
 * array as well (the base array itself is never mutated).
 *
 * Identity contract: when no extras survive dedup and no comparator is given,
 * the base array is returned as-is (same reference). Repeated renders with
 * referentially identical inputs return the previously built array.
 */
export const useMergedScopeRows = (baseRows, extraRows, options) => {
  const comparator = options?.comparator;
  const previousRef = useRef(null);
  return useMemo(() => {
    const previous = previousRef.current;
    if (previous && previous.base === baseRows && previous.extras === extraRows && previous.comparator === comparator) return previous.result;
    const seen = new Set(baseRows.map(row => row.id));
    const appended = extraRows.filter(row => !seen.has(row.id));
    let result;
    if (appended.length === 0) {
      result = comparator ? [...baseRows].sort(comparator) : baseRows;
    } else {
      const merged = [...baseRows, ...appended];
      if (comparator) merged.sort(comparator);
      result = merged;
    }
    if (previous && arraysShallowEqual(previous.result, result)) result = previous.result;
    previousRef.current = {
      base: baseRows,
      extras: extraRows,
      comparator,
      result
    };
    return result;
  }, [baseRows, extraRows, comparator]);
};
//# sourceMappingURL=useMergedScopeRows.js.map