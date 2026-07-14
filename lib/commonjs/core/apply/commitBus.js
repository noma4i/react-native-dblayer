"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createCommitBus = void 0;
const rowMatches = (dep, change) => {
  if (dep.model !== change.model || dep.id !== change.id) return false;
  if (!dep.fields || change.fields === null) return true;
  return change.fields.some(field => dep.fields.includes(field));
};
const depMatches = (dep, batch) => {
  if (dep.kind === 'model') return batch.rows.some(change => change.model === dep.model) || batch.scopes.some(change => change.model === dep.model);
  if (dep.kind === 'scope') return batch.scopes.some(change => change.model === dep.model && change.scopeKey === dep.scopeKey);
  return batch.rows.some(change => rowMatches(dep, change));
};

/**
 * Semantic commit bus: one batched publish per applied plan; each subscriber declares a dependency
 * set (per-row, per-field, per-scope, or whole-model) and is notified at most once per batch,
 * only when the batch intersects its dependencies.
 */
const createCommitBus = () => {
  const subscribers = new Set();
  return {
    subscribe: (notify, deps = []) => {
      const subscriber = {
        deps,
        notify
      };
      subscribers.add(subscriber);
      return {
        setDeps: nextDeps => {
          subscriber.deps = nextDeps;
        },
        unsubscribe: () => subscribers.delete(subscriber)
      };
    },
    publish: batch => {
      if (!batch.rows.length && !batch.scopes.length) return;
      for (const subscriber of [...subscribers]) {
        if (subscriber.deps.some(dep => depMatches(dep, batch))) subscriber.notify();
      }
    },
    subscriberCount: () => subscribers.size
  };
};
exports.createCommitBus = createCommitBus;
//# sourceMappingURL=commitBus.js.map