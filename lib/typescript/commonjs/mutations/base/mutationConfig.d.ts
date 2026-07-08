import type { DbCommandConfig, DbMutationConfig } from '../../types';
/** Capitalize the first character; returns falsy input unchanged. */
export declare const capitalize: (value: string) => string;
export declare const resolveMutationKey: <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>) => readonly unknown[];
export declare const resolveMutationLogPrefix: <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>) => string;
export declare const resolveCommandKey: <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback?: string) => readonly unknown[];
export declare const resolveCommandLogPrefix: <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback?: string) => string;
//# sourceMappingURL=mutationConfig.d.ts.map