"use strict";

/** One maintenance task outcome produced during `bootDb`. */

const runners = new Map();

/**
 * Register or replace one model's maintenance definition. This definition registry is intentionally not
 * cleared by `resetRuntime`, matching model definitions which remain available after a runtime reset.
 *
 * @param modelId Stable owning model id.
 * @param run Definition-bound runner evaluated during boot.
 * @returns Nothing.
 */
export const registerModelMaintenance = (modelId, run) => {
  runners.set(modelId, run);
};

/**
 * Run every registered model maintenance definition.
 *
 * @returns Flat reports for every configured maintenance task.
 */
export const runModelMaintenance = () => [...runners.values()].flatMap(run => run());
//# sourceMappingURL=maintenanceRegistry.js.map