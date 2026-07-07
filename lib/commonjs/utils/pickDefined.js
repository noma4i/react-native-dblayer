"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.pickPresent = exports.pickDefined = void 0;
/** Pick listed keys whose values are not undefined. Explicit null values are kept. */
const pickDefined = (source, keys) => {
  const output = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
};

/** Pick listed keys whose values are neither null nor undefined. */
exports.pickDefined = pickDefined;
const pickPresent = (source, keys) => {
  const output = {};
  for (const key of keys) {
    const value = source[key];
    if (value != null) {
      output[key] = value;
    }
  }
  return output;
};
exports.pickPresent = pickPresent;
//# sourceMappingURL=pickDefined.js.map