import type { DbMutationConfig } from '../../types';
export declare const emitMutationTrackStart: <TData, TInput, TContext, TStored, TServerNode>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>, input: TInput) => void;
export declare const emitMutationTrackSuccess: <TData, TInput, TContext, TStored, TServerNode>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>, result: TData | null, input: TInput, context: unknown) => void;
export declare const emitMutationTrackError: <TData, TInput, TContext, TStored, TServerNode>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>, error: Error, input: TInput) => void;
//# sourceMappingURL=mutationTracking.d.ts.map