"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createCheckpointScheduler = void 0;
/**
 * Checkpoint side of the WAL pair: plans persist only their journal record on the hot path
 * (O(plan)); full model snapshots (O(model) serialization) leave the frame and flush here -
 * debounced, capped, or forced by the host app on background/logout via flushPersistence().
 */
const createCheckpointScheduler = options => {
  const dirty = new Map();
  let latestEpoch = 0;
  let flushed = 0;
  let plans = 0;
  let timer = null;
  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    plans = 0;
    if (dirty.size === 0) return;
    const checkpointEpoch = latestEpoch;
    const entries = [];
    const markers = [];
    for (const [model, epoch] of dirty) {
      entries.push(...options.getTarget(model).persistEntries());
      markers.push({
        key: `${options.prefix()}applied:${model}`,
        value: String(epoch)
      });
    }
    entries.push(...markers);
    entries.push(...(options.extraEntries?.() ?? []));
    entries.push({
      key: `${options.prefix()}meta`,
      value: JSON.stringify({
        lastCheckpointEpoch: checkpointEpoch
      })
    });
    dirty.clear();
    options.storage.set(entries);
    flushed = checkpointEpoch;
  };
  return {
    notePlan: (models, epoch) => {
      for (const model of models) dirty.set(model, epoch);
      latestEpoch = Math.max(latestEpoch, epoch);
      plans += 1;
      if (plans >= options.maxPendingPlans) {
        flushNow();
        return;
      }
      if (!timer) timer = setTimeout(flushNow, options.delayMs);
    },
    flushNow,
    flushedEpoch: () => flushed,
    pendingPlans: () => plans,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      dirty.clear();
      plans = 0;
    }
  };
};
exports.createCheckpointScheduler = createCheckpointScheduler;
//# sourceMappingURL=checkpoint.js.map