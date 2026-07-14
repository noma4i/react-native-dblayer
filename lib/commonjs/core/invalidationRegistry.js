"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerModelInvalidation = exports.invalidateModel = void 0;
const registry = new Map();

/**
 * Register a query-owned invalidation callback for its destination model. defineQuery registers
 * here at definition time; model.invalidate()/defineIngest `invalidate: true` fan out through it.
 */
const registerModelInvalidation = (modelId, invalidate) => {
  const fns = registry.get(modelId) ?? new Set();
  fns.add(invalidate);
  registry.set(modelId, fns);
  return () => {
    fns.delete(invalidate);
    if (fns.size === 0) registry.delete(modelId);
  };
};

/** Fan an invalidation out to every query registered on the model. */
exports.registerModelInvalidation = registerModelInvalidation;
const invalidateModel = (modelId, scope) => {
  for (const invalidate of registry.get(modelId) ?? []) invalidate(scope);
};
exports.invalidateModel = invalidateModel;
//# sourceMappingURL=invalidationRegistry.js.map