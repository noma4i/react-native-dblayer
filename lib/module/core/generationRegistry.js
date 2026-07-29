"use strict";

import { getRuntimeGeneration } from "../utils/runtimeGeneration.js";
export const createGenerationRegistry = (readGeneration = getRuntimeGeneration) => {
  const values = new Map();
  const generations = new Map();
  const assertCanRegister = (key, errorMessage) => {
    const generation = readGeneration();
    if (values.has(key) && generations.get(key) === generation) throw new Error(errorMessage);
  };
  const register = (key, value, errorMessage) => {
    const generation = readGeneration();
    if (values.has(key) && generations.get(key) === generation) throw new Error(errorMessage);
    values.set(key, value);
    generations.set(key, generation);
    return () => {
      if (values.get(key) !== value) return;
      values.delete(key);
      generations.delete(key);
    };
  };
  return {
    assertCanRegister,
    register,
    get: key => values.get(key),
    has: key => values.has(key),
    entries: () => values.entries(),
    values: () => values.values()
  };
};
//# sourceMappingURL=generationRegistry.js.map