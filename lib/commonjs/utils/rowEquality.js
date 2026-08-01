"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.rowsShallowEqual = void 0;
var _esToolkit = require("es-toolkit");
var _arrayEquality = require("./arrayEquality.js");
/** Shallow row equality across both key sets; array values compare element identity one level deep. */
const rowsShallowEqual = (left, right) => {
  return (0, _esToolkit.union)(Object.keys(left), Object.keys(right)).every(key => {
    const leftValue = Reflect.get(left, key);
    const rightValue = Reflect.get(right, key);
    return Array.isArray(leftValue) && Array.isArray(rightValue) ? (0, _arrayEquality.arraysShallowEqual)(leftValue, rightValue) : leftValue === rightValue;
  });
};
exports.rowsShallowEqual = rowsShallowEqual;
//# sourceMappingURL=rowEquality.js.map