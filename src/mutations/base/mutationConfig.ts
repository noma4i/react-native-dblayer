import type { DbCommandConfig, DbMutationConfig } from '../../types';

/** Capitalize the first character; returns falsy input unchanged. */
export const capitalize = (value: string): string => {
  if (!value) return value;
  return value[0]!.toUpperCase() + value.slice(1);
};

export const resolveMutationKey = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>): readonly unknown[] =>
  config.key ? config.key() : [config.resultField];

export const resolveMutationLogPrefix = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>): string =>
  config.logPrefix ?? capitalize(config.resultField);

export const resolveCommandKey = <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback = 'command'): readonly unknown[] => (config.key ? config.key() : [fallback]);

export const resolveCommandLogPrefix = <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback = 'command'): string => config.logPrefix ?? capitalize(fallback);
