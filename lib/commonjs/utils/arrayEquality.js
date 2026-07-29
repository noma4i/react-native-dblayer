"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.arraysShallowEqual = arraysShallowEqual;
function arraysShallowEqual(left, right, equals = Object.is) {
  return left === right || left.length === right.length && left.every((item, index) => equals(item, right[index]));
}
//# sourceMappingURL=arrayEquality.js.map