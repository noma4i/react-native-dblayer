import type { StoragePlane } from '../planes/storagePlane';

export type CheckpointTarget = { persistEntries(): Array<{ key: string; value: string | null }> };

export type CheckpointScheduler = {
  /** Note one applied plan touching these models; schedules (or forces) a snapshot flush. */
  notePlan(models: ReadonlyArray<string>, epoch: number): void;
  /**
   * Flush pending model snapshots, their applied-epoch markers and the checkpoint meta in ONE
   * ordered storage batch. Meta and applied markers come AFTER the snapshots they describe, so a
   * torn batch can never claim coverage for data that was not written.
   */
  flushNow(): void;
  /** Highest epoch covered by a completed flush - the journal prune gate. */
  flushedEpoch(): number;
  pendingPlans(): number;
  cancel(): void;
};

/**
 * Checkpoint side of the WAL pair: plans persist only their journal record on the hot path
 * (O(plan)); full model snapshots (O(model) serialization) leave the frame and flush here -
 * debounced, capped, or forced by the host app on background/logout via flushPersistence().
 */
export const createCheckpointScheduler = (options: {
  storage: StoragePlane;
  prefix: () => string;
  getTarget(model: string): CheckpointTarget;
  delayMs: number;
  maxPendingPlans: number;
  /** Extra storage entries appended to every flush batch (e.g. the operation ledger). */
  extraEntries?: () => Array<{ key: string; value: string | null }>;
}): CheckpointScheduler => {
  const dirty = new Map<string, number>();
  let latestEpoch = 0;
  let flushed = 0;
  let plans = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    plans = 0;
    if (dirty.size === 0) return;
    const checkpointEpoch = latestEpoch;
    const entries: Array<{ key: string; value: string | null }> = [];
    const markers: Array<{ key: string; value: string | null }> = [];
    for (const [model, epoch] of dirty) {
      entries.push(...options.getTarget(model).persistEntries());
      markers.push({ key: `${options.prefix()}applied:${model}`, value: String(epoch) });
    }
    entries.push(...markers);
    entries.push(...(options.extraEntries?.() ?? []));
    entries.push({ key: `${options.prefix()}meta`, value: JSON.stringify({ lastCheckpointEpoch: checkpointEpoch }) });
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
