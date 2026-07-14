type InvalidateFn = (scope?: unknown) => void;

const registry = new Map<string, Set<InvalidateFn>>();

/**
 * Register a query-owned invalidation callback for its destination model. defineQuery registers
 * here at definition time; model.invalidate()/defineIngest `invalidate: true` fan out through it.
 */
export const registerModelInvalidation = (modelId: string, invalidate: InvalidateFn): (() => void) => {
  const fns = registry.get(modelId) ?? new Set<InvalidateFn>();
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
