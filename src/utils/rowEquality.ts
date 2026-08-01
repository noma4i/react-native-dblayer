import { union } from 'es-toolkit';
import { arraysShallowEqual } from './arrayEquality';

/** Shallow row equality across both key sets; array values compare element identity one level deep. */
export const rowsShallowEqual = (left: object, right: object): boolean => {
  return union(Object.keys(left), Object.keys(right)).every(key => {
    const leftValue = Reflect.get(left, key);
    const rightValue = Reflect.get(right, key);
    return Array.isArray(leftValue) && Array.isArray(rightValue) ? arraysShallowEqual(leftValue, rightValue) : leftValue === rightValue;
  });
};
