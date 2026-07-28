type InvalidateFn = (scope?: unknown) => void;
/**
 * Register a query-owned invalidation callback for its destination model. defineQuery registers
 * here at definition time; model.invalidate()/defineIngest `invalidate: true` fan out through it.
 *
 * Registered once per `defineQuery` call (a static, define-time registration - the same lifecycle as
 * `registerGcHost`/`registerRelationHost`); the registry survives `resetRuntime` so queries keep
 * invalidating correctly after the kill-switch. The returned unregister closure exists for callers
 * that redefine a query at runtime (e.g. a Fast Refresh reload of the module); a one-time app-startup
 * `defineQuery` call is not expected to call it.
 */
export declare const registerModelInvalidation: (modelId: string, invalidate: InvalidateFn) => (() => void);
/** Fan an invalidation out to every query registered on the model. */
export declare const invalidateModel: (modelId: string, scope?: unknown) => void;
export {};
//# sourceMappingURL=invalidationRegistry.d.ts.map