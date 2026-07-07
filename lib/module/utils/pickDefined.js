"use strict";

/** Pick listed keys whose values are not undefined. Explicit null values are kept. */
export const pickDefined = (source, keys) => {
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
export const pickPresent = (source, keys) => {
  const output = {};
  for (const key of keys) {
    const value = source[key];
    if (value != null) {
      output[key] = value;
    }
  }
  return output;
};
//# sourceMappingURL=pickDefined.js.map