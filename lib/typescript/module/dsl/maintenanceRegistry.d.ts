import type { MaintenanceReport, MaintenanceRunner } from '../types';
/**
 * Register or replace one model's maintenance definition. This definition registry is intentionally not
 * cleared by `resetRuntime`, matching model definitions which remain available after a runtime reset.
 *
 * @param modelId Stable owning model id.
 * @param run Definition-bound runner evaluated during boot.
 * @returns Nothing.
 */
export declare const registerModelMaintenance: (modelId: string, runner: MaintenanceRunner) => void;
/**
 * Run every registered model maintenance definition.
 *
 * @returns Flat reports for every configured maintenance task.
 */
export declare const runModelMaintenance: () => MaintenanceReport[];
/** Run the model-owned unresolved-temp cleanup executor from any maintenance cadence. */
export declare const runPendingTempRowMaintenance: () => MaintenanceReport[];
/** Return the current model-declared protection set used by every unresolved-temp cleanup path. */
export declare const isTempRowProtectedByModel: (modelId: string, id: string) => boolean;
//# sourceMappingURL=maintenanceRegistry.d.ts.map