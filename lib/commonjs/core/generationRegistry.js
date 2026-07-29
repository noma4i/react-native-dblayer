"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createGenerationRegistry = void 0;
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
const createGenerationRegistry = (readGeneration = _runtimeGeneration.getRuntimeGeneration) => {
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
exports.createGenerationRegistry = createGenerationRegistry;
//# sourceMappingURL=generationRegistry.js.map