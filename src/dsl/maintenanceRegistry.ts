import type { MaintenanceReport } from '../types';
import { getRuntimeGeneration } from './configure';

type MaintenanceRunner = { boot(): MaintenanceReport[]; pendingTempRows(): MaintenanceReport[]; protectedTempIds(): ReadonlySet<string> };

const runners = new Map<string, MaintenanceRunner>();
const runnerGenerations = new Map<string, number>();

/**
 * Register or replace one model's maintenance definition. This definition registry is intentionally not
 * cleared by `resetRuntime`, matching model definitions which remain available after a runtime reset.
 *
 * @param modelId Stable owning model id.
 * @param run Definition-bound runner evaluated during boot.
 * @returns Nothing.
 */
export const registerModelMaintenance = (modelId: string, runner: MaintenanceRunner): void => {
  const generation = getRuntimeGeneration();
  if (runners.has(modelId) && runnerGenerations.get(modelId) === generation) throw new Error(`Maintenance runner already registered for model ${modelId}`);
  runners.set(modelId, runner);
  runnerGenerations.set(modelId, generation);
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
