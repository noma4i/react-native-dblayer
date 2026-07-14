type InvalidateFn = (scope?: unknown) => void;
/**
 * Register a query-owned invalidation callback for its destination model. defineQuery registers
 * here at definition time; model.invalidate()/defineIngest `invalidate: true` fan out through it.
 */
export declare const registerModelInvalidation: (modelId: string, invalidate: InvalidateFn) => (() => void);
/** Fan an invalidation out to every query registered on the model. */
export declare const invalidateModel: (modelId: string, scope?: unknown) => void;
export {};
//# sourceMappingURL=invalidationRegistry.d.ts.map