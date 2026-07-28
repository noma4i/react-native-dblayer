"use strict";

import { getRuntimeGeneration } from "../dsl/configure.js";

/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts.
 * @returns A current-generation predicate and an explicit capture operation.
 */
export const createGenerationFence = options => {
  let generation = options?.lazy ? null : getRuntimeGeneration();
  return {
    isCurrent: () => generation == null || generation === getRuntimeGeneration(),
    captureNow: () => {
      generation = getRuntimeGeneration();
    }
  };
};
//# sourceMappingURL=runtimeGeneration.js.map