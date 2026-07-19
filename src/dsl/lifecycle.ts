import type { GcReport } from '../core/gc';
import { collectGarbage } from '../core/gc';
import { resetRuntime } from '../core/reset';
import { runBootValidations } from './bootValidations';
import { flushPersistence, isDbConfigured, purgeForeignStorageKeys, replayJournal } from './configure';
import { runModelMaintenance, type MaintenanceReport } from './maintenanceRegistry';

export type BootDbOptions = {
  /** Discard all persisted and in-memory library state before journal replay. */
  wipe?: boolean;
};

/**
 * Recommended data-startup sequence after `configureDb`: deferred definition validation, then
 * `replayJournal()` to recover any WAL-only writes from a crash, then `collectGarbage()` to reclaim
 * unreachable rows left over from that replay, then `purgeForeignStorageKeys()` to clear any
 * pre-migration/foreign storage keys - in exactly that order, once, before the first render that reads a model.
 *
 * Every model module MUST be imported (so `defineModel` has registered its apply target) before calling
 * this - `replayJournal` throws on a journal record whose model has no registered apply target, and that
 * throw is intentionally loud here: `bootDb` does not catch or swallow validation or replay errors, since a
 * silent partial boot is worse than a startup crash.
 *
 * `replayJournal`, `collectGarbage`, and `purgeForeignStorageKeys` remain individually exported as
 * composable primitives for callers with a different startup sequencing need.
 *
 * Pass `wipe: true` to discard all persisted and in-memory library state (the `resetRuntime`
 * kill-switch) between validation and replay - boot then starts from an empty store. Use it for
 * consumer-side schema/cache-version bumps where stale persisted rows must not be rehydrated.
 *
 * @param options Boot-only data lifecycle options. Runtime seams must already be configured.
 * @returns `replayed` - the journal record count `replayJournal` recovered; `gc` - the `collectGarbage`
 * report for the post-replay sweep.
 */
export const bootDb = async (options: BootDbOptions = {}): Promise<{ replayed: number; gc: GcReport; maintenance: MaintenanceReport[] }> => {
  const { wipe } = options;
  runBootValidations();
  if (wipe) resetRuntime();
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
