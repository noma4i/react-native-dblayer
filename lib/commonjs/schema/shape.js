"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readShape = exports.defineShape = void 0;
const isReadableObject = input => typeof input === 'object' && input !== null && !Array.isArray(input);
const defineShape = () => fields => ({
  fields
});
exports.defineShape = defineShape;
const readShape = (shape, input) => {
  if (!isReadableObject(input)) return undefined;
  const output = {};
  for (const key of Object.keys(shape.fields)) {
    const value = shape.fields[key].read(input, key);
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
};
exports.readShape = readShape;
//# sourceMappingURL=shape.js.map