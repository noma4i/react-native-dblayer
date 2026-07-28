/** One maintenance task outcome produced during `bootDb`. */
export type MaintenanceReport = { model: string; task: 'maxRowsPerScope' | 'dropTempRows'; affected: number };
