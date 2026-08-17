import type { WriteOp } from '../types';
type OptimisticInsertPlanner = (input: unknown, tempId: string, operationId: string) => WriteOp[];
export declare const registerOptimisticInsertPlanner: (modelId: string, actionKey: string, planner: OptimisticInsertPlanner) => void;
/** The optimistic row plan of one action for one ledger input, or null when the action declares no insert root. */
export declare const planOptimisticInsert: (modelId: string, actionKey: string, input: unknown, tempId: string, operationId: string) => WriteOp[] | null;
export {};
//# sourceMappingURL=optimisticInsertPlanners.d.ts.map