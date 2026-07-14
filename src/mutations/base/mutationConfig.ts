import type { DbCommandConfig } from '../../types';

/** Capitalize the first character; returns falsy input unchanged. */
export const capitalize = (value: string): string => {
  if (!value) return value;
  return value[0]!.toUpperCase() + value.slice(1);
};

export const resolveCommandKey = <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback = 'command'): readonly unknown[] => (config.key ? config.key() : [fallback]);

export const resolveCommandLogPrefix = <TData, TInput>(config: DbCommandConfig<TData, TInput>, fallback = 'command'): string => config.logPrefix ?? capitalize(fallback);
