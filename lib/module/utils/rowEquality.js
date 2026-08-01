"use strict";

import { union } from 'es-toolkit';
import { arraysShallowEqual } from "./arrayEquality.js";

/** Shallow row equality across both key sets; array values compare element identity one level deep. */
export const rowsShallowEqual = (left, right) => {
  return union(Object.keys(left), Object.keys(right)).every(key => {
    const leftValue = Reflect.get(left, key);
    const rightValue = Reflect.get(right, key);
    return Array.isArray(leftValue) && Array.isArray(rightValue) ? arraysShallowEqual(leftValue, rightValue) : leftValue === rightValue;
  });
};
//# sourceMappingURL=rowEquality.js.map