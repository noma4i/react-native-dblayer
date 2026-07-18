"use strict";

import { getCommitBus } from "../dsl/configure.js";
import { collectGarbage } from "./gc.js";
const DEFAULT_THRESHOLD = 500;
const DEFAULT_DEBOUNCE_MS = 1000;

/**
 * Start the in-session garbage-collection trigger: watches every applied commit batch on the
 * shared commit bus and runs `collectGarbage()` once enough eviction-shaped pressure has
 * accumulated, debounced so a burst of writes produces one sweep instead of one per batch.
 *
 * Pressure accumulates per non-maintenance batch as (count of `batch.rows` entries whose `fields`
 * is `null` - both destroys and brand-new inserts report `null` on `RowChange`, so both count) +
 * (sum of every `batch.scopeChanges[].detachIds.length`). Batches published by `collectGarbage()`
 * itself carry `mode: 'maintenance'` and are skipped entirely, so a sweep can never re-trigger
 * itself through its own eviction/detach rows.
 *
 * Once accumulated pressure reaches `threshold` and no timer is already pending, a `debounceMs`
 * timer is armed; further pressure while the timer pends keeps accumulating but does not restart
 * or add a second timer. When the timer fires, `collectGarbage()` runs once and pressure resets to
 * zero, ready to accumulate toward the next sweep.
 *
 * @param options.threshold Accumulated pressure that arms a sweep. Defaults to 500.
 * @param options.debounceMs Delay after crossing `threshold` before the sweep runs. Defaults to 1000.
 * @returns Teardown: unsubscribes from the commit bus, clears any pending timer, and zeroes pressure.
 */
export const startMaintenanceScheduler = options => {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let pressure = 0;
  let timer = null;
  const onBatch = batch => {
    if (batch.mode === 'maintenance') return;
    const evicted = batch.rows.filter(row => row.fields === null).length;
    const detached = (batch.scopeChanges ?? []).reduce((sum, change) => sum + (change.detachIds?.length ?? 0), 0);
    pressure += evicted + detached;
    if (pressure >= threshold && !timer) {
      timer = setTimeout(() => {
        collectGarbage();
        pressure = 0;
        timer = null;
      }, debounceMs);
    }
  };
  const unsubscribe = getCommitBus().subscribeAll(onBatch);
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
    pressure = 0;
  };
};
//# sourceMappingURL=maintenanceScheduler.js.map