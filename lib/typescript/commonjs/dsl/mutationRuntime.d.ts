import type { DefinedMutation, MutationConfig } from '../types';
/** Internal shared replacement seam for mutation commits and `Model.replace` reconciliation. */
export declare const clearFailedOptimisticMutation: (model: string, tempId: string) => void;
export declare const createMutationRuntime: <TData, TInput, TStored extends {
    id: string;
}, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => Pick<DefinedMutation<TData, TInput>, "run" | "retry" | "discard">;
//# sourceMappingURL=mutationRuntime.d.ts.map