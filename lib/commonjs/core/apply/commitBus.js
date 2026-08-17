"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createCommitBus = void 0;
var _diagnostics = require("../diagnostics.js");
const rowMatches = (dep, change) => {
  if (dep.model !== change.model || dep.id !== change.id) return false;
  if (!dep.fields || change.fields === null) return true;
  return change.fields.some(field => dep.fields.includes(field));
};
const depMatches = (dep, batch) => {
  if (dep.kind === 'model') return batch.rows.some(change => change.model === dep.model) || batch.scopes.some(change => change.model === dep.model);
  if (dep.kind === 'scope') return batch.scopes.some(change => change.model === dep.model && change.scopeKey === dep.scopeKey);
  if (dep.kind === 'pending') return batch.pending?.some(change => change.model === dep.model && change.id === dep.id) === true;
  return batch.rows.some(change => rowMatches(dep, change));
};

/**
 * Semantic commit bus: one batched publish per applied plan; each subscriber declares a dependency
 * set (per-row, per-field, per-scope, per-pending-id, or whole-model) and is notified at most once per batch,
 * only when the batch intersects its dependencies.
 */
const createCommitBus = () => {
  const subscribers = new Set();
  const retained = new Set();
  const subscribersByModel = new Map();
  const allSubscribers = new Set();
  let sequence = 0;
  const modelsOf = deps => new Set(deps.map(dep => dep.model));
  const addToModelBuckets = (subscriber, models) => {
    for (const model of models) {
      const bucket = subscribersByModel.get(model) ?? new Set();
      bucket.add(subscriber);
      subscribersByModel.set(model, bucket);
    }
  };
  const removeFromModelBuckets = (subscriber, models) => {
    for (const model of models) {
      const bucket = subscribersByModel.get(model);
      if (!bucket) continue;
      bucket.delete(subscriber);
      // Stryker disable next-line ConditionalExpression: retaining an empty private bucket is observably equivalent.
      if (bucket.size === 0) subscribersByModel.delete(model);
    }
  };
  const subscribe = (notify, deps = [], onBatch) => {
    const subscriber = {
      deps,
      notify,
      onBatch
    };
    subscribers.add(subscriber);
    addToModelBuckets(subscriber, modelsOf(deps));
    return {
      unsubscribe: () => {
        removeFromModelBuckets(subscriber, modelsOf(subscriber.deps));
        subscribers.delete(subscriber);
      }
    };
  };
  return {
    subscribe,
    subscribeIncremental: (notify, deps, onBatch) => subscribe(notify, deps, onBatch),
    subscribeAll: onBatch => {
      allSubscribers.add(onBatch);
      return () => allSubscribers.delete(onBatch);
    },
    /**
     * Hold rows for a reader that gets its changes elsewhere. A live query of the collection engine
     * notifies its own readers, but the rows it serves are still in use, so it declares them here -
     * otherwise maintenance would collect rows that are on screen.
     */
    retain: deps => {
      const entry = {
        deps
      };
      retained.add(entry);
      return () => retained.delete(entry);
    },
    /** Snapshot of live reader dependencies. */
    activeDependencies: () => [...subscribers, ...retained].flatMap(holder => holder.deps),
    sequence: () => sequence,
    publish: batch => {
      if (!batch.rows.length && !batch.scopes.length && !batch.pending?.length) return;
      sequence += 1;
      for (const onBatch of [...allSubscribers]) onBatch(batch);
      const batchModels = new Set([...batch.rows, ...batch.scopes, ...(batch.pending ?? [])].map(change => change.model));
      const candidates = new Set();
      for (const model of batchModels) {
        for (const subscriber of subscribersByModel.get(model) ?? []) candidates.add(subscriber);
      }
      let notified = 0;
      for (const subscriber of [...candidates]) {
        if (subscriber.deps.some(dep => depMatches(dep, batch))) {
          subscriber.onBatch?.(batch);
          subscriber.notify();
          notified += 1;
        }
      }
      (0, _diagnostics.noteCommitFanout)(candidates.size, notified);
    },
    publishAll: () => {
      sequence += 1;
      for (const subscriber of [...subscribers]) {
        subscriber.onBatch?.(null);
        subscriber.notify();
      }
    },
    subscriberCount: () => subscribers.size
  };
};
exports.createCommitBus = createCommitBus;
//# sourceMappingURL=commitBus.js.map