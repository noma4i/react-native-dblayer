/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export declare const getRuntimeGeneration: () => number;
/** Establish a new generation before configuration or reset tears down the old runtime. */
export declare const advanceRuntimeGeneration: () => void;
/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts, or pass an
 * explicitly captured `generation` when several owners share one boot boundary.
 * @returns A current-generation predicate and an explicit capture operation.
 */
export declare const createGenerationFence: (options?: {
    lazy?: boolean;
    generation?: number;
}) => {
    isCurrent(): boolean;
    captureNow(): void;
};
//# sourceMappingURL=runtimeGeneration.d.ts.map