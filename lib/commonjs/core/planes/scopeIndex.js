"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createScopeIndex = void 0;
const createScopeIndex = () => {
  const scopes = new Map();
  const empty = () => ({
    generation: 0,
    coverage: 'delta',
    entries: []
  });
  return {
    read: key => scopes.get(key) ?? empty(),
    write: (key, next) => {
      scopes.set(key, next);
    },
    reconcile: (key, coverage, ids) => {
      const previous = scopes.get(key) ?? empty();
      const entries = coverage === 'complete' ? ids.map((id, order) => ({
        id,
        order,
        seq: previous.generation + 1
      })) : previous.entries;
      const next = {
        generation: previous.generation + 1,
        coverage,
        entries
      };
      scopes.set(key, next);
      return next;
    },
    reset: () => scopes.clear()
  };
};
exports.createScopeIndex = createScopeIndex;
//# sourceMappingURL=scopeIndex.js.map