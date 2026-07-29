"use strict";

import { createGenerationRegistry } from "../generationRegistry.js";
const targets = createGenerationRegistry();

/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale
 * target so recreated runtimes can reuse stable model ids.
 */
export const registerApplyTarget = (model, target) => {
  return targets.register(model, target, `Apply target already registered for model ${model}`);
};
export const getApplyTarget = model => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};
export const getApplyTargets = () => [...targets.entries()];
//# sourceMappingURL=applyTargetRegistry.js.map