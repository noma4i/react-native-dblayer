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
  /** Every model ever seen via notePlan/noteMaintenance - a superset of `dirty` that survives across
   *  flushes, so a quiescent model (no new writes since the last flush) still gets its
   *  persistEntries()/pruneTombstones() called on every cycle instead of being skipped entirely. */
  const knownModels = new Set();
  let latestEpoch = 0;
  let flushed = 0;
  let plans = 0;
  let timer = null;
  let afterFlush = null;
  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    plans = 0;
    if (knownModels.size === 0) return;
    const checkpointEpoch = latestEpoch;
    const entries = [];
    const markers = [];
    for (const model of knownModels) {
      const epoch = dirty.get(model);
      // Called for every known model, dirty or quiescent, so tombstones decay by TTL alone.
      entries.push(...options.getTarget(model).persistEntries());
      if (epoch !== undefined) markers.push({
        key: `${options.prefix()}applied:${model}`,
        value: String(epoch)
      });
    }
    dirty.clear();
    if (entries.length === 0 && markers.length === 0) return;
    entries.push(...markers);
    entries.push(...(options.extraEntries?.() ?? []));
    entries.push({
      key: `${options.prefix()}meta`,
      value: JSON.stringify({
        lastCheckpointEpoch: checkpointEpoch
      })
    });
    options.storage.set(entries);
    flushed = checkpointEpoch;
    afterFlush?.(checkpointEpoch);
  };
  const schedule = () => {
    plans += 1;
    if (plans >= options.maxPendingPlans) {
      flushNow();
      return;
    }
    if (!timer) timer = setTimeout(flushNow, options.delayMs);
  };
  return {
    notePlan: (models, epoch) => {
      for (const model of models) {
        dirty.set(model, epoch);
        knownModels.add(model);
      }
      latestEpoch = Math.max(latestEpoch, epoch);
      schedule();
    },
    noteMaintenance: models => {
      for (const model of models) {
        if (!dirty.has(model)) dirty.set(model, undefined);
        knownModels.add(model);
      }
      schedule();
    },
    flushNow,
    flushedEpoch: () => flushed,
    setAfterFlush: callback => {
      afterFlush = callback;
    },
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