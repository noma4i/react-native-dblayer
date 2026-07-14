"use strict";

const registry = new Map();

/**
 * Register a query-owned invalidation callback for its destination model. defineQuery registers
 * here at definition time; model.invalidate()/defineIngest `invalidate: true` fan out through it.
 */
export const registerModelInvalidation = (modelId, invalidate) => {
  const fns = registry.get(modelId) ?? new Set();
  fns.add(invalidate);
  registry.set(modelId, fns);
  return () => {
    fns.delete(invalidate);
    if (fns.size === 0) registry.delete(modelId);
  };
};

/** Fan an invalidation out to every query registered on the model. */
export const invalidateModel = (modelId, scope) => {
  for (const invalidate of registry.get(modelId) ?? []) invalidate(scope);
};
//# sourceMappingURL=invalidationRegistry.js.map