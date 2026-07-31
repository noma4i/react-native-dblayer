import { Debouncer } from '@tanstack/pacer';
import type { StoragePlane, CheckpointScheduler, CheckpointTarget } from '../../types';
import { encodePersistence } from '../persistenceCodec';

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
  const dirty = new Map<string, number | undefined>();
  /** Every model ever seen via notePlan/noteMaintenance - a superset of `dirty` that survives across
   *  flushes, so a quiescent model (no new writes since the last flush) still gets its
   *  persistEntries()/pruneTombstones() called on every cycle instead of being skipped entirely. */
  const knownModels = new Set<string>();
  let latestEpoch = 0;
  let flushed = 0;
  let plans = 0;
  let afterFlush: ((epoch: number) => void) | null = null;

  function flushNow(): void {
    checkpointDeadline.cancel();
    const checkpointEpoch = latestEpoch;
    const entries: Array<{ key: string; value: string | null }> = [];
    const markers: Array<{ key: string; value: string | null }> = [];
    for (const model of knownModels) {
      const epoch = dirty.get(model);
      // Called for every known model, dirty or quiescent, so tombstones decay by TTL alone.
      entries.push(...options.getTarget(model).persistEntries());
      if (epoch !== undefined) markers.push({ key: `${options.prefix()}applied:${model}`, value: encodePersistence(epoch) });
    }
    if (entries.length === 0 && markers.length === 0) {
      plans = 0;
      return;
    }
    entries.push(...markers);
    entries.push(...(options.extraEntries?.() ?? []));
    entries.push({ key: `${options.prefix()}meta`, value: encodePersistence({ lastCheckpointEpoch: checkpointEpoch }) });
    options.storage.set(entries);
    // Ack strictly after the successful write: a thrown set keeps every dirty marker AND the pending-plan backlog for the next flush.
    plans = 0;
    for (const model of knownModels) options.getTarget(model).ackPersist();
    dirty.clear();
    flushed = checkpointEpoch;
    afterFlush?.(checkpointEpoch);
  }
  const checkpointDeadline = new Debouncer(flushNow, { wait: options.delayMs });

  const schedule = (): void => {
    plans += 1;
    if (plans >= options.maxPendingPlans) {
      flushNow();
      return;
    }
    if (!checkpointDeadline.store.state.isPending) checkpointDeadline.maybeExecute();
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
      checkpointDeadline.cancel();
      dirty.clear();
      plans = 0;
    }
  };
};
