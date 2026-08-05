"use strict";

import { reconcilePersistence } from "../core/schemaManifest.js";
import { runBootValidations } from "./bootValidations.js";
import { purgeForeignStorageKeys } from "./configure.js";
import { runModelMaintenance } from "./maintenanceRegistry.js";
import { getApplyTargets } from "../core/apply/applyTargetRegistry.js";
import { runBootFsck } from "../core/bootFsck.js";
import { hydrateStoreScopes, markStoresReady } from "../core/store.js";
import { createGenerationFence } from "../utils/runtimeGeneration.js";

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
export const bootDb = async () => {
  runBootValidations();
  const reconciliation = reconcilePersistence();
  const generationFence = createGenerationFence();
  const assertCurrentGeneration = () => {
    if (!generationFence.isCurrent()) throw new Error('runtime generation changed during boot');
  };
  runBootFsck();
  assertCurrentGeneration();
  hydrateStoreScopes(getApplyTargets());
  assertCurrentGeneration();
  markStoresReady();
  assertCurrentGeneration();
  purgeForeignStorageKeys();
  assertCurrentGeneration();
  const maintenance = runModelMaintenance();
  assertCurrentGeneration();
  return {
    maintenance,
    reset: reconciliation.reset
  };
};
//# sourceMappingURL=lifecycle.js.map