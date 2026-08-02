import type { CompiledWritePlan, InvalidationTarget, WritePlan, WritePlanCollectorOptions } from '../types';
export declare const runWritePlanInvalidations: (targets: readonly InvalidationTarget[], isCurrent: () => boolean, onError: (error: unknown) => void) => boolean;
export declare const createWritePlanCollector: (options?: WritePlanCollectorOptions) => {
    plan: WritePlan;
    compile(): CompiledWritePlan;
};
//# sourceMappingURL=writePlan.d.ts.map