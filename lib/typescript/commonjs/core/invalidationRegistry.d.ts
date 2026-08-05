import type { InvalidateFn } from '../types';
/**
 * Register a query-owned invalidation callback for its destination model, keyed by the query's
 * definition identity. defineQuery registers here at definition time; model.invalidate()/
 * Model event write plans fan out invalidation through it.
 *
 * A definition registry: it survives `resetRuntime` so queries keep invalidating correctly after
 * the kill-switch, and re-registering the same (model, key) pair REPLACES the previous callback,
 * so redefining a query (e.g. a Fast Refresh reload) never accumulates dead closures.
 */
export declare const registerModelInvalidation: (modelId: string, key: string, invalidate: InvalidateFn) => void;
/** Fan an invalidation out to every query registered on the model; returns how many accepted the address. */
export declare const invalidateModel: (modelId: string, scope?: unknown) => number;
//# sourceMappingURL=invalidationRegistry.d.ts.map