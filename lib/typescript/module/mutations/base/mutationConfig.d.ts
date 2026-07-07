import type { DbCommandConfig, DbMutationConfig } from '../../types';
export declare const resolveMutationKey: <TData, TInput, TContext, TStored, TServerNode>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>) => readonly unknown[];
export declare const resolveMutationLogPrefix: <TData, TInput, TContext, TStored, TServerNode>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>) => string;
export declare const resolveCommandKey: <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback?: string) => readonly unknown[];
export declare const resolveCommandLogPrefix: <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback?: string) => string;
//# sourceMappingURL=mutationConfig.d.ts.map