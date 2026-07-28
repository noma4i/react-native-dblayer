import type { InvalidateFn } from '../types';
const registry = new Map<string, Set<InvalidateFn>>();

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
export const registerModelInvalidation = (modelId: string, invalidate: InvalidateFn): (() => void) => {
  const fns = registry.get(modelId) ?? new Set<InvalidateFn>();
  if (fns.has(invalidate)) throw new Error(`Invalidation callback already registered for model ${modelId}`);
  fns.add(invalidate);
  registry.set(modelId, fns);
  return () => {
    fns.delete(invalidate);
    if (fns.size === 0) registry.delete(modelId);
  };
};

/** Fan an invalidation out to every query registered on the model. */
export const invalidateModel = (modelId: string, scope?: unknown): void => {
  for (const invalidate of registry.get(modelId) ?? []) invalidate(scope);
};
