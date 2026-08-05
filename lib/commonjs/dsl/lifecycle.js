"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.bootDb = void 0;
var _schemaManifest = require("../core/schemaManifest.js");
var _bootValidations = require("./bootValidations.js");
var _configure = require("./configure.js");
var _maintenanceRegistry = require("./maintenanceRegistry.js");
var _applyTargetRegistry = require("../core/apply/applyTargetRegistry.js");
var _bootFsck = require("../core/bootFsck.js");
var _store = require("../core/store.js");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
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
const bootDb = async () => {
  (0, _bootValidations.runBootValidations)();
  const reconciliation = (0, _schemaManifest.reconcilePersistence)();
  const generationFence = (0, _runtimeGeneration.createGenerationFence)();
  const assertCurrentGeneration = () => {
    if (!generationFence.isCurrent()) throw new Error('runtime generation changed during boot');
  };
  (0, _bootFsck.runBootFsck)();
  assertCurrentGeneration();
  (0, _store.hydrateStoreScopes)((0, _applyTargetRegistry.getApplyTargets)());
  assertCurrentGeneration();
  (0, _store.markStoresReady)();
  assertCurrentGeneration();
  (0, _configure.purgeForeignStorageKeys)();
  assertCurrentGeneration();
  const maintenance = (0, _maintenanceRegistry.runModelMaintenance)();
  assertCurrentGeneration();
  return {
    maintenance,
    reset: reconciliation.reset
  };
};
exports.bootDb = bootDb;
//# sourceMappingURL=lifecycle.js.map