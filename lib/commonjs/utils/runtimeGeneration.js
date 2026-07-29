"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getRuntimeGeneration = exports.createGenerationFence = exports.advanceRuntimeGeneration = void 0;
let runtimeGeneration = 0;

/** Monotonic identity for the configured runtime; async continuations must not cross it. */
const getRuntimeGeneration = () => runtimeGeneration;

/** Establish a new generation before configuration or reset tears down the old runtime. */
exports.getRuntimeGeneration = getRuntimeGeneration;
const advanceRuntimeGeneration = () => {
  runtimeGeneration += 1;
};

/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts, or pass an
 * explicitly captured `generation` when several owners share one boot boundary.
 * @returns A current-generation predicate and an explicit capture operation.
 */
exports.advanceRuntimeGeneration = advanceRuntimeGeneration;
const createGenerationFence = options => {
  let generation = options?.generation ?? (options?.lazy ? null : getRuntimeGeneration());
  return {
    isCurrent: () => generation == null || generation === getRuntimeGeneration(),
    captureNow: () => {
      generation = getRuntimeGeneration();
    }
  };
};
exports.createGenerationFence = createGenerationFence;
//# sourceMappingURL=runtimeGeneration.js.map