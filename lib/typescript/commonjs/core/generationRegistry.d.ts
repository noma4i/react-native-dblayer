export declare const createGenerationRegistry: <T>(readGeneration?: () => number) => {
    assertCanRegister(key: string, errorMessage: string): void;
    register(key: string, value: T, errorMessage: string): () => void;
    get(key: string): T | undefined;
    has(key: string): boolean;
    entries(): IterableIterator<[string, T]>;
    values(): IterableIterator<T>;
};
//# sourceMappingURL=generationRegistry.d.ts.map