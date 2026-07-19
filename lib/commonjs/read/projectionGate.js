"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.validateProjectionOptions = exports.useProjectedLiveRows = exports.useProjectedLiveRow = exports.createProjectionGate = void 0;
var _react = require("react");
var _useLiveRead = require("./useLiveRead.js");
const equalityValue = (source, output, options) => {
  if (options.select) return output;
  if (options.renderKeys) return Object.fromEntries(options.renderKeys.map(key => [key, source[key]]));
  return output;
};

/** Throw when a read declares both mutually exclusive projection modes. */
const validateProjectionOptions = (options, surface) => {
  if (options?.select && options.renderKeys) throw new Error(`${surface} cannot use select and renderKeys together`);
};

/** Create one hook-local row projection gate with stable item and array references. */
exports.validateProjectionOptions = validateProjectionOptions;
const createProjectionGate = () => {
  const entries = new Map();
  let previousRows = [];
  return {
    projectValue(id, source, output, renderKeys) {
      const current = entries.get(id);
      if (current && current.source === source) return current.output;
      const nextEqualityValue = renderKeys ? Object.fromEntries(renderKeys.map(key => [key, output[key]])) : output;
      if (current && (0, _useLiveRead.rowsShallowEqual)(current.equalityValue, nextEqualityValue)) {
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
      if ((0, _useLiveRead.arraysShallowEqual)(previousRows, next)) return previousRows;
      previousRows = next;
      return next;
    }
  };
};

/** Read and gate one optional stored row while keeping selector identity outside dependencies. */
exports.createProjectionGate = createProjectionGate;
const useProjectedLiveRow = (compute, deps, options, surface) => {
  validateProjectionOptions(options, surface);
  const optionsRef = (0, _react.useRef)(options);
  const gateRef = (0, _react.useRef)(createProjectionGate());
  optionsRef.current = options;
  return (0, _useLiveRead.useLiveRead)(() => {
    const row = compute();
    return row ? gateRef.current.project(row, optionsRef.current) : undefined;
  }, deps, Object.is);
};

/** Read and gate stored rows while keeping selector identity outside dependencies. */
exports.useProjectedLiveRow = useProjectedLiveRow;
const useProjectedLiveRows = (compute, deps, options, surface) => {
  validateProjectionOptions(options, surface);
  const optionsRef = (0, _react.useRef)(options);
  const gateRef = (0, _react.useRef)(createProjectionGate());
  optionsRef.current = options;
  return (0, _useLiveRead.useLiveRead)(() => gateRef.current.projectRows(compute(), optionsRef.current), deps, _useLiveRead.arraysShallowEqual);
};
exports.useProjectedLiveRows = useProjectedLiveRows;
//# sourceMappingURL=projectionGate.js.map