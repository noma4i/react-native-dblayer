import { getDbLogger } from '../../core/logger';
import { emitDbTrackEvent, hasDbTrackSink } from '../../core/tracking';
import type { DbMutationConfig, DbTrackEvent } from '../../types';

const emitResolvedTrackEvent = (event: DbTrackEvent | null | undefined, logPrefix: string, phase: string): void => {
  if (!event) return;
  emitDbTrackEvent(event, logPrefix, phase);
};

export const emitMutationTrackStart = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  input: TInput
): void => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.start;
  if (!resolve) return;

  try {
    emitResolvedTrackEvent(resolve(input), config.logPrefix, 'start');
  } catch (error) {
    getDbLogger().debug(config.logPrefix, 'track resolver failed', 'start', error);
  }
};

export const emitMutationTrackSuccess = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  result: TData | null,
  input: TInput,
  context: unknown
): void => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.success as ((data: TData | null, input: TInput, context: unknown) => DbTrackEvent | null | undefined) | undefined;
  if (!resolve) return;

  try {
    emitResolvedTrackEvent(resolve(result, input, context), config.logPrefix, 'success');
  } catch (error) {
    getDbLogger().debug(config.logPrefix, 'track resolver failed', 'success', error);
  }
};

export const emitMutationTrackError = <TData, TInput, TContext, TStored, TServerNode>(
  config: DbMutationConfig<TData, TInput, TContext, TStored, TServerNode>,
  error: Error,
  input: TInput
): void => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.error;
  if (!resolve) return;

  try {
    emitResolvedTrackEvent(resolve(error, input), config.logPrefix, 'error');
  } catch (trackError) {
    getDbLogger().debug(config.logPrefix, 'track resolver failed', 'error', trackError);
  }
};
