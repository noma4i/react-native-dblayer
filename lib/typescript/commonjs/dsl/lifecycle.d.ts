import type { MaintenanceReport } from '../types';
/**
 * Recommended data-startup sequence after `configureDb`: deferred definition validation, persistence
 * compatibility validation, then `replayJournal()` to recover any WAL-only writes from a crash, then
 * `purgeForeignStorageKeys()` to clear any pre-migration/foreign storage keys, then the declared model
 * maintenance - in exactly that order, once, before the first render that reads a model.
 *
 * Boot reads and repairs; it never reclaims. A row survives every restart until a declaration removes
 * it, so nothing here decides that stored data has outlived its usefulness.
 *
 * Every model module MUST be imported (so `defineModel` has registered its apply target) before calling
 * this - `replayJournal` throws on a journal record whose model has no registered apply target, and that
 * throw is intentionally loud here: `bootDb` does not catch or swallow validation or replay errors, since a
 * silent partial boot is worse than a startup crash.
 *
 * @returns `replayed` - the journal record count `replayJournal` recovered; `maintenance` - reports of
 * every declared model maintenance task; `reset` - whether an incompatible persisted schema was cleared.
 */
export declare const bootDb: () => Promise<{
    replayed: number;
    maintenance: MaintenanceReport[];
    reset: boolean;
}>;
/**
 * Recommended app-background/teardown sequence: write pending checkpoint snapshots to storage now, so
 * that everything held in memory survives a process kill. Call this on app background/inactive and
 * before logout teardown (a full state wipe still goes through `resetRuntime`'s kill-switch).
 *
 * Backgrounding discards nothing. The app going out of view says nothing about which rows the user
 * still wants, and this runs immediately before the process may be killed - the one moment where
 * discarding a row makes it unrecoverable.
 *
 * Safe to call repeatedly, and safe to call before `configureDb` has run: it no-ops when there is
 * nothing scheduled.
 */
export declare const suspendDb: () => void;
//# sourceMappingURL=lifecycle.d.ts.map