'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});
exports.pickPresent = exports.pickDefined = void 0;
var _esToolkit = require('es-toolkit');
/**
 * Pick listed keys whose values are not undefined. Explicit null values are kept.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch with undefined values removed.
 */
const pickDefined = (source, keys) => (0, _esToolkit.omitBy)((0, _esToolkit.pick)(source, [...keys]), _esToolkit.isUndefined);
exports.pickDefined = pickDefined;
/**
 * Pick listed keys whose values are neither null nor undefined.
 *
 * @param source Source object to read.
 * @param keys Source keys eligible for the output patch.
 * @returns Sparse source-key patch whose value types exclude null and undefined.
 */
const pickPresent = (source, keys) => (0, _esToolkit.pickBy)((0, _esToolkit.pick)(source, [...keys]), _esToolkit.isNotNil);
exports.pickPresent = pickPresent;
//# sourceMappingURL=pickDefined.js.map
