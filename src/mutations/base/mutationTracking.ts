import { emitConfiguredTrackEvent } from '../../core/tracking';
import type { DbMutationConfig, DbTrackEvent } from '../../types';
import { resolveMutationLogPrefix } from './mutationConfig';

export const emitMutationTrackStart = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  input: TInput
): void => {
  emitConfiguredTrackEvent(config.track?.start, [input], resolveMutationLogPrefix(config), 'start');
};

export const emitMutationTrackSuccess = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  result: TData | null,
  input: TInput,
  context: unknown
): void => {
  const resolve = config.track?.success as ((data: TData | null, input: TInput, context: unknown) => DbTrackEvent | null | undefined) | undefined;
  emitConfiguredTrackEvent(resolve, [result, input, context], resolveMutationLogPrefix(config), 'success');
};

export const emitMutationTrackError = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  error: Error,
  input: TInput
): void => {
  emitConfiguredTrackEvent(config.track?.error, [error, input], resolveMutationLogPrefix(config), 'error');
};
