import type { DestroyOptimistic, MutationConfig, PatchOptimistic, RespondOptimistic } from '../types';
export declare const isMethodOptimistic: <TData, TInput, TStored, TNode>(value: NonNullable<MutationConfig<TData, TInput, TStored, TNode>["optimistic"]>) => value is PatchOptimistic<TInput, TStored> | DestroyOptimistic<TInput>;
export declare const isRespondOptimistic: <TData, TInput, TStored, TNode>(value: NonNullable<MutationConfig<TData, TInput, TStored, TNode>["optimistic"]>) => value is RespondOptimistic<TData, TInput, TNode>;
export declare const validateMutationConfig: <TData, TInput, TStored, TNode>(config: MutationConfig<TData, TInput, TStored, TNode>) => void;
//# sourceMappingURL=mutationConfiguration.d.ts.map