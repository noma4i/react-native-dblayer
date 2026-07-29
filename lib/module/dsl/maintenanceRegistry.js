"use strict";

import { createGenerationRegistry } from "../core/generationRegistry.js";
const runners = createGenerationRegistry();

/**
 * Register or replace one model's maintenance definition. This definition registry is intentionally not
 * cleared by `resetRuntime`, matching model definitions which remain available after a runtime reset.
 *
 * @param modelId Stable owning model id.
 * @param run Definition-bound runner evaluated during boot.
 * @returns Nothing.
 */
export const registerModelMaintenance = (modelId, runner) => {
  runners.register(modelId, runner, `Maintenance runner already registered for model ${modelId}`);
};

/**
 * Run every registered model maintenance definition.
 *
 * @returns Flat reports for every configured maintenance task.
 */
export const runModelMaintenance = () => [...runners.values()].flatMap(runner => runner.boot());

/** Run the model-owned unresolved-temp cleanup executor from any maintenance cadence. */
export const runPendingTempRowMaintenance = () => [...runners.values()].flatMap(runner => runner.pendingTempRows());

/** Return the current model-declared protection set used by every unresolved-temp cleanup path. */
export const isTempRowProtectedByModel = (modelId, id) => runners.get(modelId)?.protectedTempIds().has(id) ?? false;
//# sourceMappingURL=maintenanceRegistry.js.map