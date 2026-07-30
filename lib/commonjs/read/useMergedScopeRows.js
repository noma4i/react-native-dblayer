"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useMergedScopeRows = void 0;
var _react = require("react");
var _ordering = require("../core/ordering.js");
var _arrayEquality = require("../utils/arrayEquality.js");
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
const useMergedScopeRows = (baseRows, extraRows, options) => {
  const comparator = options?.comparator;
  // Concurrent-render safety: this ref is a pure memo keyed by the FULL input identity (base, extras,
  // comparator). A discarded or interleaved concurrent render can only overwrite it with an entry
  // derived from the same pure computation, and result identity is re-guarded by arraysShallowEqual,
  // so no render can observe a value that differs from what its own inputs produce.
  const previousRef = (0, _react.useRef)(null);
  return (0, _react.useMemo)(() => {
    const previous = previousRef.current;
    const seen = new Set(baseRows.map(row => row.id));
    const appended = extraRows.filter(row => !seen.has(row.id));
    let result;
    if (appended.length === 0) {
      result = comparator ? [...baseRows].sort((0, _ordering.withIdTieBreak)(comparator)) : baseRows;
    } else {
      const merged = [...baseRows, ...appended];
      if (comparator) merged.sort((0, _ordering.withIdTieBreak)(comparator));
      result = merged;
    }
    if (previous && (0, _arrayEquality.arraysShallowEqual)(previous.result, result)) result = previous.result;
    previousRef.current = {
      base: baseRows,
      extras: extraRows,
      comparator,
      result
    };
    return result;
  }, [baseRows, extraRows, comparator]);
};
exports.useMergedScopeRows = useMergedScopeRows;
//# sourceMappingURL=useMergedScopeRows.js.map