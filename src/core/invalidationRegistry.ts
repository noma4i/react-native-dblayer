import type { InvalidateFn } from '../types';
const registry = new Map<string, Map<string, InvalidateFn>>();

/**
 * Register a query-owned invalidation callback for its destination model, keyed by the query's
 * definition identity. defineQuery registers here at definition time; model.invalidate()/
 * Model event write plans fan out invalidation through it.
 *
 * A definition registry: it survives `resetRuntime` so queries keep invalidating correctly after
 * the kill-switch, and re-registering the same (model, key) pair REPLACES the previous callback,
 * so redefining a query (e.g. a Fast Refresh reload) never accumulates dead closures.
 */
export const registerModelInvalidation = (modelId: string, key: string, invalidate: InvalidateFn): void => {
  const fns = registry.get(modelId) ?? new Map<string, InvalidateFn>();
  fns.set(key, invalidate);
  registry.set(modelId, fns);
};

/** Fan an invalidation out to every query registered on the model. */
export const invalidateModel = (modelId: string, scope?: unknown): void => {
  for (const invalidate of registry.get(modelId)?.values() ?? []) invalidate(scope);
};
