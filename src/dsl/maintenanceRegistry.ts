import type { MaintenanceReport, MaintenanceRunner } from '../types';
import { createGenerationRegistry } from '../core/generationRegistry';

const runners = createGenerationRegistry<MaintenanceRunner>();

/**
 * Register or replace one model's maintenance definition. This definition registry is intentionally not
 * cleared by `resetRuntime`, matching model definitions which remain available after a runtime reset.
 *
 * @param modelId Stable owning model id.
 * @param run Definition-bound runner evaluated during boot.
 * @returns Nothing.
 */
export const registerModelMaintenance = (modelId: string, runner: MaintenanceRunner): void => {
  runners.register(modelId, runner, `Maintenance runner already registered for model ${modelId}`);
};

/**
 * Run every registered model maintenance definition.
 *
 * @returns Flat reports for every configured maintenance task.
 */
export const runModelMaintenance = (): MaintenanceReport[] => [...runners.values()].flatMap(runner => runner.boot());

/** Run the model-owned unresolved-temp cleanup executor from any maintenance cadence. */
export const runPendingTempRowMaintenance = (): MaintenanceReport[] => [...runners.values()].flatMap(runner => runner.pendingTempRows());

/** Return the current model-declared protection set used by every unresolved-temp cleanup path. */
export const isTempRowProtectedByModel = (modelId: string, id: string): boolean => runners.get(modelId)?.protectedTempIds().has(id) ?? false;
