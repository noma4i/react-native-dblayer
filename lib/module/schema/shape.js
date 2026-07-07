"use strict";

const isReadableObject = input => typeof input === 'object' && input !== null && !Array.isArray(input);
export const defineShape = () => fields => ({
  fields
});
export const readShape = (shape, input) => {
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
//# sourceMappingURL=shape.js.map