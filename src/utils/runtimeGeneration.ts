let runtimeGeneration = 0;

/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export const getRuntimeGeneration = (): number => runtimeGeneration;

/** Establish a new generation before configuration or reset tears down the old runtime. */
export const advanceRuntimeGeneration = (): void => {
  runtimeGeneration += 1;
};

/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts, or pass an
 * explicitly captured `generation` when several owners share one boot boundary.
 * @returns A current-generation predicate and an explicit capture operation.
 */
export const createGenerationFence = (options?: { lazy?: boolean; generation?: number }): { isCurrent(): boolean; captureNow(): void } => {
  let generation: number | null = options?.generation ?? (options?.lazy ? null : getRuntimeGeneration());
  return {
    isCurrent: () => generation == null || generation === getRuntimeGeneration(),
    captureNow: () => {
      generation = getRuntimeGeneration();
    }
  };
};
