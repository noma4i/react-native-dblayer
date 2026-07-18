"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.startMaintenanceScheduler = void 0;
var _configure = require("../dsl/configure.js");
var _gc = require("./gc.js");
var _transaction = require("./apply/transaction.js");
const DEFAULT_THRESHOLD = 500;
const DEFAULT_DEBOUNCE_MS = 1000;

/**
 * True when a `fields === null` row has actually disappeared (destroyed or evicted) rather than
 * just being a brand-new insert - `EntityState.upsert`'s `changedFields` is also `null` for a
 * first-ever write, so `fields === null` alone is ambiguous between "gone" and "just created".
 * Reads the model's current apply-target snapshot; an unregistered model (should not happen for a
 * row that was just in a commit batch, but mirrors the defensive pattern `tanstack/mirror.ts` uses
 * for the same lookup) is treated as not-disappeared.
 */
const hasDisappeared = row => {
  let target;
  try {
    target = (0, _transaction.getApplyTarget)(row.model);
  } catch {
    return false;
  }
  return target.readRow(row.id) === undefined;
};

/**
 * Start the in-session garbage-collection trigger: watches every applied commit batch on the
 * shared commit bus and runs `collectGarbage()` once enough eviction-shaped pressure has
 * accumulated, debounced so a burst of writes produces one sweep instead of one per batch.
 *
 * Pressure accumulates per non-maintenance batch as (count of `batch.rows` entries whose `fields`
 * is `null` AND whose row has actually disappeared - see `hasDisappeared`; a `fields === null` row
 * from a bulk insert reports `null` too but has NOT disappeared, so it contributes no pressure) +
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
const startMaintenanceScheduler = options => {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let pressure = 0;
  let timer = null;
  const onBatch = batch => {
    if (batch.mode === 'maintenance') return;
    const disappeared = batch.rows.filter(row => row.fields === null && hasDisappeared(row)).length;
    const detached = (batch.scopeChanges ?? []).reduce((sum, change) => sum + (change.detachIds?.length ?? 0), 0);
    pressure += disappeared + detached;
    if (pressure >= threshold && !timer) {
      timer = setTimeout(() => {
        (0, _gc.collectGarbage)();
        pressure = 0;
        timer = null;
      }, debounceMs);
    }
  };
  const unsubscribe = (0, _configure.getCommitBus)().subscribeAll(onBatch);
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
    pressure = 0;
  };
};
exports.startMaintenanceScheduler = startMaintenanceScheduler;
//# sourceMappingURL=maintenanceScheduler.js.map