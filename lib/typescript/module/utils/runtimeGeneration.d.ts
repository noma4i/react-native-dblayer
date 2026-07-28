/**
 * Capture the current runtime generation and expose a reset fence for async work.
 *
 * @param options Set `lazy` when a lifecycle owner captures only when it starts.
 * @returns A current-generation predicate and an explicit capture operation.
 */
export declare const createGenerationFence: (options?: {
    lazy?: boolean;
}) => {
    isCurrent(): boolean;
    captureNow(): void;
};
//# sourceMappingURL=runtimeGeneration.d.ts.map