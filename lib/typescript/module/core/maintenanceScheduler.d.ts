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
export declare const startMaintenanceScheduler: (options?: {
    threshold?: number;
    debounceMs?: number;
}) => (() => void);
//# sourceMappingURL=maintenanceScheduler.d.ts.map