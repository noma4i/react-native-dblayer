"use strict";

import { collectGarbage } from "../core/gc.js";
import { ensurePersistenceCompatibility } from "../core/schemaManifest.js";
import { registerReset } from "../core/reset.js";
import { runBootValidations } from "./bootValidations.js";
import { flushPersistence, getRuntimeGeneration, isDbConfigured, purgeForeignStorageKeys, replayJournal } from "./configure.js";
import { reconcileDetachedOperationsAtBoot } from "./defineDetachedOperation.js";
import { runModelMaintenance } from "./maintenanceRegistry.js";
import { getApplyTargets } from "../core/apply/applyTargetRegistry.js";
import { hydrateStoreScopes, markStoresReady } from "../core/store.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";

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
export const bootDb = async () => {
  runBootValidations();
  const compatibility = ensurePersistenceCompatibility();
  const generation = getRuntimeGeneration();
  const generationFence = createGenerationFence({
    generation
  });
  const assertCurrentGeneration = () => {
    if (!generationFence.isCurrent()) throw new Error('runtime generation changed during boot');
  };
  let rejectReset;
  const resetSignal = new Promise((_resolve, reject) => {
    rejectReset = reject;
  });
  const unregisterReset = registerReset(() => {
    rejectReset(new Error('runtime generation changed during boot'));
  });
  try {
    const replayed = replayJournal();
    assertCurrentGeneration();
    hydrateStoreScopes(getApplyTargets());
    markStoresReady();
    await Promise.race([reconcileDetachedOperationsAtBoot(generation), resetSignal]);
    assertCurrentGeneration();
    const gc = collectGarbage();
    assertCurrentGeneration();
    purgeForeignStorageKeys();
    const maintenance = runModelMaintenance();
    assertCurrentGeneration();
    return {
      replayed,
      gc,
      maintenance,
      reset: compatibility.reset
    };
  } finally {
    unregisterReset();
  }
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
export const suspendDb = () => {
  flushPersistence();
  if (isDbConfigured()) collectGarbage();
};
//# sourceMappingURL=lifecycle.js.map