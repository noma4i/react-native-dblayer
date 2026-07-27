import { getRuntimeGeneration } from '../dsl/configure';

/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts.
 * @returns A current-generation predicate and an explicit capture operation.
 */
export const createGenerationFence = (options?: { lazy?: boolean }): { isCurrent(): boolean; captureNow(): void } => {
  let generation: number | null = options?.lazy ? null : getRuntimeGeneration();
  return {
    isCurrent: () => generation == null || generation === getRuntimeGeneration(),
    captureNow: () => { generation = getRuntimeGeneration(); }
  };
};
