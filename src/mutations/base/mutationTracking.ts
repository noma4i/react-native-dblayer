import { getDbLogger } from '../../core/logger';
import { emitDbTrackEvent, hasDbTrackSink } from '../../core/tracking';
import type { DbMutationConfig, DbTrackEvent } from '../../types';
import { resolveMutationLogPrefix } from './mutationConfig';

const emitResolvedTrackEvent = (event: DbTrackEvent | null | undefined, logPrefix: string, phase: string): void => {
  if (!event) return;
  emitDbTrackEvent(event, logPrefix, phase);
};

export const emitMutationTrackStart = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  input: TInput
): void => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.start;
  if (!resolve) return;
  const logPrefix = resolveMutationLogPrefix(config);

  try {
    emitResolvedTrackEvent(resolve(input), logPrefix, 'start');
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track resolver failed', 'start', error);
  }
};

export const emitMutationTrackSuccess = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  result: TData | null,
  input: TInput,
  context: unknown
): void => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.success as ((data: TData | null, input: TInput, context: unknown) => DbTrackEvent | null | undefined) | undefined;
  if (!resolve) return;
  const logPrefix = resolveMutationLogPrefix(config);

  try {
    emitResolvedTrackEvent(resolve(result, input, context), logPrefix, 'success');
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track resolver failed', 'success', error);
  }
};

export const emitMutationTrackError = <TData, TInput, TContext, TStored, TServerNode, TExtractSpec>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode, TExtractSpec>,
  error: Error,
  input: TInput
): void => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.error;
  if (!resolve) return;
  const logPrefix = resolveMutationLogPrefix(config);

  try {
    emitResolvedTrackEvent(resolve(error, input), logPrefix, 'error');
  } catch (trackError) {
    getDbLogger().debug(logPrefix, 'track resolver failed', 'error', trackError);
  }
};
