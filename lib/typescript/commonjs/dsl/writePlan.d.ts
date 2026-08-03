import type { CompiledWritePlan, InvalidationTarget, WriteOp, WritePlan, WritePlanCollectorOptions } from '../types';
export declare const stampCausalRevision: (ops: readonly WriteOp[], baseRevision: number) => WriteOp[];
export declare const runWritePlanInvalidations: (targets: readonly InvalidationTarget[], isCurrent: () => boolean, onError: (error: unknown) => void) => boolean;
export declare const createWritePlanCollector: <TOwnerKey extends string = never>(options?: WritePlanCollectorOptions<TOwnerKey>) => {
    plan: WritePlan<TOwnerKey>;
    compile(): CompiledWritePlan;
};
//# sourceMappingURL=writePlan.d.ts.map