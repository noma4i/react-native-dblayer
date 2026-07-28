"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createGenerationFence = void 0;
var _configure = require("../dsl/configure.js");
/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts.
 * @returns A current-generation predicate and an explicit capture operation.
 */
const createGenerationFence = options => {
  let generation = options?.lazy ? null : (0, _configure.getRuntimeGeneration)();
  return {
    isCurrent: () => generation == null || generation === (0, _configure.getRuntimeGeneration)(),
    captureNow: () => {
      generation = (0, _configure.getRuntimeGeneration)();
    }
  };
};
exports.createGenerationFence = createGenerationFence;
//# sourceMappingURL=runtimeGeneration.js.map