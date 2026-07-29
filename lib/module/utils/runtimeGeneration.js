"use strict";

let runtimeGeneration = 0;

/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export const getRuntimeGeneration = () => runtimeGeneration;

/** Establish a new generation before configuration or reset tears down the old runtime. */
export const advanceRuntimeGeneration = () => {
  runtimeGeneration += 1;
};

/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts, or pass an
 * explicitly captured `generation` when several owners share one boot boundary.
 * @returns A current-generation predicate and an explicit capture operation.
 */
export const createGenerationFence = options => {
  let generation = options?.generation ?? (options?.lazy ? null : getRuntimeGeneration());
  return {
    isCurrent: () => generation == null || generation === getRuntimeGeneration(),
    captureNow: () => {
      generation = getRuntimeGeneration();
    }
  };
};
//# sourceMappingURL=runtimeGeneration.js.map