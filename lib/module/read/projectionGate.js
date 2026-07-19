"use strict";

import { useRef } from 'react';
import { arraysShallowEqual, rowsShallowEqual, useLiveRead } from "./useLiveRead.js";
const equalityValue = (source, output, options) => {
  if (options.select) return output;
  if (options.renderKeys) return Object.fromEntries(options.renderKeys.map(key => [key, source[key]]));
  return output;
};

/** Throw when a read declares both mutually exclusive projection modes. */
export const validateProjectionOptions = (options, surface) => {
  if (options?.select && options.renderKeys) throw new Error(`${surface} cannot use select and renderKeys together`);
};

/** Create one hook-local row projection gate with stable item and array references. */
export const createProjectionGate = () => {
  const entries = new Map();
  let previousRows = [];
  return {
    projectValue(id, source, output, renderKeys) {
      const current = entries.get(id);
      if (current && current.source === source) return current.output;
      const nextEqualityValue = renderKeys ? Object.fromEntries(renderKeys.map(key => [key, output[key]])) : output;
      if (current && rowsShallowEqual(current.equalityValue, nextEqualityValue)) {
        entries.set(id, {
          source,
          output: current.output,
          equalityValue: nextEqualityValue
        });
        return current.output;
      }
      entries.set(id, {
        source,
        output,
        equalityValue: nextEqualityValue
      });
      return output;
    },
    project(row, options) {
      const output = options.select ? options.select(row) : row;
      const nextEqualityValue = equalityValue(row, output, options);
      return this.projectValue(row.id, row, output, Object.keys(nextEqualityValue));
    },
    projectRows(rows, options) {
      const liveIds = new Set(rows.map(row => row.id));
      const next = rows.map(row => this.project(row, options));
      for (const id of entries.keys()) if (!liveIds.has(id)) entries.delete(id);
      if (arraysShallowEqual(previousRows, next)) return previousRows;
      previousRows = next;
      return next;
    }
  };
};

/** Read and gate one optional stored row while keeping selector identity outside dependencies. */
export const useProjectedLiveRow = (compute, deps, options, surface) => {
  validateProjectionOptions(options, surface);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate());
  optionsRef.current = options;
  return useLiveRead(() => {
    const row = compute();
    return row ? gateRef.current.project(row, optionsRef.current) : undefined;
  }, deps, Object.is);
};

/** Read and gate stored rows while keeping selector identity outside dependencies. */
export const useProjectedLiveRows = (compute, deps, options, surface) => {
  validateProjectionOptions(options, surface);
  const optionsRef = useRef(options);
  const gateRef = useRef(createProjectionGate());
  optionsRef.current = options;
  return useLiveRead(() => gateRef.current.projectRows(compute(), optionsRef.current), deps, arraysShallowEqual);
};
//# sourceMappingURL=projectionGate.js.map