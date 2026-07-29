"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerApplyTarget = exports.getApplyTargets = exports.getApplyTarget = void 0;
var _generationRegistry = require("../generationRegistry.js");
const targets = (0, _generationRegistry.createGenerationRegistry)();

/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale
 * target so recreated runtimes can reuse stable model ids.
 */
const registerApplyTarget = (model, target) => {
  return targets.register(model, target, `Apply target already registered for model ${model}`);
};
exports.registerApplyTarget = registerApplyTarget;
const getApplyTarget = model => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};
exports.getApplyTarget = getApplyTarget;
const getApplyTargets = () => [...targets.entries()];
exports.getApplyTargets = getApplyTargets;
//# sourceMappingURL=applyTargetRegistry.js.map