"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.pickPresent = exports.pickDefined = void 0;
/**
 * Pick listed keys whose values are not undefined. Explicit null values are kept.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch with undefined values removed.
 */
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
exports.pickDefined = pickDefined;
/**
 * Pick listed keys whose values are neither null nor undefined.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch whose value types exclude null and undefined.
 */
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