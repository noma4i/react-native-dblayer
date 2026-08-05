import type { MaintenanceReport } from '../types';
/**
 * Recommended data-startup sequence after `configureDb`: deferred definition validation, the
 * persistence reconcile, then the boot fsck to repair any partially-written commit, then
 * `purgeForeignStorageKeys()` to clear any pre-migration/foreign storage keys, then the declared model
 * maintenance - in exactly that order, once, before the first render that reads a model.
 *
 * Boot reads and repairs; it never reclaims. A row survives every restart until a declaration removes
 * it, so nothing here decides that stored data has outlived its usefulness.
 *
 * Every model module MUST be imported (so `defineModel` has registered its apply target) before calling
 * this - the fsck commits repairs through registered apply targets, and a missing target is intentionally
 * loud here: `bootDb` does not catch or swallow validation or repair errors, since a silent partial boot
 * is worse than a startup crash.
 *
 * @returns `maintenance` - reports of every declared model maintenance task; `reset` - whether a full
 * incompatible namespace reset cleared persisted state. Model-level schema migrations leave `reset` false.
 */
export declare const bootDb: () => Promise<{
    maintenance: MaintenanceReport[];
    reset: boolean;
}>;
//# sourceMappingURL=lifecycle.d.ts.map