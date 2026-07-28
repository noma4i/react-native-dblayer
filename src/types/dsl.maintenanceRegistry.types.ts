/** One maintenance task outcome produced during `bootDb`. */
export type MaintenanceReport = { model: string; task: 'maxRowsPerScope' | 'dropTempRows'; affected: number };

/** Internal per-model maintenance runner: boot tasks, temp-row TTL sweep, and protected temp ids. */
export type MaintenanceRunner = { boot(): MaintenanceReport[]; pendingTempRows(): MaintenanceReport[]; protectedTempIds(): ReadonlySet<string> };
