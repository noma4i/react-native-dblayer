import type { GcReport } from '../core/gc';
import { collectGarbage } from '../core/gc';
import { runBootValidations } from './bootValidations';
import { configureDb, flushPersistence, isDbConfigured, purgeForeignStorageKeys, replayJournal } from './configure';
import { runModelMaintenance, type MaintenanceReport } from './maintenanceRegistry';

/**
 * Recommended app-startup sequence: `configureDb(options)`, then deferred definition validation, then
 * `replayJournal()` to recover any WAL-only writes from a crash, then `collectGarbage()` to reclaim
 * unreachable rows left over from that replay, then `purgeForeignStorageKeys()` to clear any
 * pre-migration/foreign storage keys - in exactly that order, once, before the first render that reads a model.
 *
 * Every model module MUST be imported (so `defineModel` has registered its apply target) before calling
 * this - `replayJournal` throws on a journal record whose model has no registered apply target, and that
 * throw is intentionally loud here: `bootDb` does not catch or swallow validation or replay errors, since a
 * silent partial boot is worse than a startup crash.
 *
 * `configureDb`, `replayJournal`, `collectGarbage`, and `purgeForeignStorageKeys` remain individually
 * exported as composable primitives for callers with a different startup sequencing need; `bootDb` is the
 * recommended path for the common case.
 *
 * @param options The exact `configureDb` options (transport, storage, queryClient, logger, defaults).
 * @returns `replayed` - the journal record count `replayJournal` recovered; `gc` - the `collectGarbage`
 * report for the post-replay sweep.
 */
export const bootDb = async (options: Parameters<typeof configureDb>[0]): Promise<{ replayed: number; gc: GcReport; maintenance: MaintenanceReport[] }> => {
  configureDb(options);
  runBootValidations();
  const replayed = await replayJournal();
  const gc = collectGarbage();
  purgeForeignStorageKeys();
  const maintenance = runModelMaintenance();
  return { replayed, gc, maintenance };
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
