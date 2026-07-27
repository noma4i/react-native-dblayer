import type { GcReport } from '../core/gc';
import { collectGarbage } from '../core/gc';
import { ensurePersistenceCompatibility } from '../core/schemaManifest';
import { runBootValidations } from './bootValidations';
import { flushPersistence, isDbConfigured, purgeForeignStorageKeys, replayJournal } from './configure';
import { reconcileDetachedOperationsAtBoot } from './defineDetachedOperation';
import { runModelMaintenance, type MaintenanceReport } from './maintenanceRegistry';

/**
 * Recommended data-startup sequence after `configureDb`: deferred definition validation, persistence
 * compatibility validation, then
 * `replayJournal()` to recover any WAL-only writes from a crash, then `collectGarbage()` to reclaim
 * unreachable rows left over from that replay, then `purgeForeignStorageKeys()` to clear any
 * pre-migration/foreign storage keys - in exactly that order, once, before the first render that reads a model.
 *
 * Every model module MUST be imported (so `defineModel` has registered its apply target) before calling
 * this - `replayJournal` throws on a journal record whose model has no registered apply target, and that
 * throw is intentionally loud here: `bootDb` does not catch or swallow validation or replay errors, since a
 * silent partial boot is worse than a startup crash.
 *
 * Journal replay and foreign-key purging are internal boot steps; manual maintenance remains available
 * through `flushPersistence` and `collectGarbage`.
 *
 * @returns `replayed` - the journal record count `replayJournal` recovered; `gc` - the `collectGarbage`
 * report for the post-replay sweep; `reset` - whether an incompatible persisted schema was cleared.
 */
export const bootDb = async (): Promise<{ replayed: number; gc: GcReport; maintenance: MaintenanceReport[]; reset: boolean }> => {
  runBootValidations();
  const compatibility = ensurePersistenceCompatibility();
  const replayed = await replayJournal();
  await reconcileDetachedOperationsAtBoot();
  const gc = collectGarbage();
  purgeForeignStorageKeys();
  const maintenance = runModelMaintenance();
  return { replayed, gc, maintenance, reset: compatibility.reset };
};

/**
 * Recommended app-background/teardown sequence: `flushPersistence()` to write pending checkpoint
 * snapshots to storage now, then `collectGarbage()` to reclaim rows that became unreachable since the
 * last sweep. Call this on app background/inactive and before logout teardown (a full state wipe should
 * still go through `resetRuntime`'s kill-switch - `suspendDb` only flushes and reclaims, it never clears).
 *
 * Safe to call repeatedly, and safe to call before `configureDb` has run: `flushPersistence` no-ops when
 * there is nothing scheduled, and the `collectGarbage` sweep is skipped entirely before configuration
 * (there is nothing to reclaim yet).
 */
export const suspendDb = (): void => {
  flushPersistence();
  if (isDbConfigured()) collectGarbage();
};
