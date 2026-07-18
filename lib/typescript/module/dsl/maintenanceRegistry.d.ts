/** One maintenance task outcome produced during `bootDb`. */
export type MaintenanceReport = {
    model: string;
    task: 'maxRowsPerScope';
    affected: number;
};
/**
 * Register or replace one model's maintenance definition. This definition registry is intentionally not
 * cleared by `resetRuntime`, matching model definitions which remain available after a runtime reset.
 *
 * @param modelId Stable owning model id.
 * @param run Definition-bound runner evaluated during boot.
 * @returns Nothing.
 */
export declare const registerModelMaintenance: (modelId: string, run: () => MaintenanceReport[]) => void;
/**
 * Run every registered model maintenance definition.
 *
 * @returns Flat reports for every configured maintenance task.
 */
export declare const runModelMaintenance: () => MaintenanceReport[];
//# sourceMappingURL=maintenanceRegistry.d.ts.map