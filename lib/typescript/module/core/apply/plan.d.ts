import type { JournalOp } from './journal';
export type ApplyPlan = {
    ops: JournalOp[];
    hash: string;
};
/** Build a side-effect-free plan before opening an in-memory transaction. */
export declare const createApplyPlan: (ops: JournalOp[]) => ApplyPlan;
//# sourceMappingURL=plan.d.ts.map