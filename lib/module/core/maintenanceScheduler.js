"use strict";

import { Debouncer } from '@tanstack/pacer';
import { getCommitBus } from "../dsl/configure.js";
import { collectGarbage } from "./gc.js";
import { getApplyTarget } from "./apply/applyTargetRegistry.js";
import { getDbLogger } from "./logger.js";
const DEFAULT_THRESHOLD = 500;
const DEFAULT_DEBOUNCE_MS = 1000;

/**
 * True when a `fields === null` row has actually disappeared (destroyed or evicted) rather than
 * just being a brand-new insert - `EntityState.upsert`'s `changedFields` is also `null` for a
 * first-ever write, so `fields === null` alone is ambiguous between "gone" and "just created".
 * Reads the model's current apply-target snapshot; an unregistered model (should not happen for a
 * row that was just in a commit batch, but follows the defensive scope-reader pattern
 * for the same lookup) is treated as not-disappeared.
 */
const hasDisappeared = row => {
  let target;
  try {
    target = getApplyTarget(row.model);
  } catch {
    return false;
  }
  return target.readRow(row.id) === undefined;
};

/**
 * Start the in-session garbage-collection trigger: watches every applied commit batch on the
 * shared commit bus and runs `collectGarbage()` once enough eviction-shaped pressure has
 * accumulated, then paced so a burst of writes produces one sweep instead of one per batch.
 *
 * Pressure accumulates per non-maintenance batch as (count of `batch.rows` entries whose `fields`
 * is `null` AND whose row has actually disappeared - see `hasDisappeared`; a `fields === null` row
 * from a bulk insert reports `null` too but has NOT disappeared, so it contributes no pressure) +
 * (sum of every `batch.scopeChanges[].detachIds.length`). Batches published by `collectGarbage()`
 * itself carry `mode: 'maintenance'` and are skipped entirely, so a sweep can never re-trigger
 * itself through its own eviction/detach rows.
 *
 * Once accumulated pressure reaches `threshold`, one Pacer deadline is armed. Further pressure
 * keeps accumulating but does not restart the pending deadline, so continuous writes cannot starve
 * maintenance. When the deadline fires, `collectGarbage()` runs once and pressure resets to zero.
 *
 * @param options.threshold Accumulated pressure that arms a sweep. Defaults to 500.
 * @param options.debounceMs Delay after crossing `threshold` before the sweep runs. Defaults to 1000.
 * @returns Teardown: unsubscribes from the commit bus, clears any pending timer, and zeroes pressure.
 */
export const startMaintenanceScheduler = options => {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let pressure = 0;
  const sweep = new Debouncer(() => {
    try {
      collectGarbage();
    } catch (error) {
      getDbLogger().error('MaintenanceScheduler', 'garbage collection failed', {
        error
      });
    } finally {
      pressure = 0;
    }
  }, {
    wait: debounceMs
  });
  const onBatch = batch => {
    if (batch.mode === 'maintenance') return;
    const disappeared = batch.rows.filter(row => row.fields === null && hasDisappeared(row)).length;
    const detached = (batch.scopeChanges ?? []).reduce((sum, change) => sum + (change.detachIds?.length ?? 0), 0);
    pressure += disappeared + detached;
    if (pressure >= threshold && !sweep.store.state.isPending) sweep.maybeExecute();
  };
  const unsubscribe = getCommitBus().subscribeAll(onBatch);
  return () => {
    unsubscribe();
    sweep.cancel();
    pressure = 0;
  };
};
//# sourceMappingURL=maintenanceScheduler.js.map