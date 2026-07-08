import { emitConfiguredTrackEvent } from '../../core/tracking';
import type { DbCommandMutationConfig, DbTrackEvent } from '../../types';
import { capitalize } from './mutationConfig';

const resolveCommandTrackLogPrefix = <TInput, TData, TExtractSpec>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>): string =>
  config.logPrefix ?? (typeof config.resultField === 'string' ? capitalize(config.resultField) : 'Command');

export const emitCommandTrackStart = <TInput, TData, TExtractSpec>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>, input: TInput): void => {
  emitConfiguredTrackEvent(config.track?.start, [input], resolveCommandTrackLogPrefix(config), 'start');
};

export const emitCommandTrackSuccess = <TInput, TData, TExtractSpec>(
  config: DbCommandMutationConfig<TInput, TData, TExtractSpec>,
  result: TData | null,
  input: TInput
): void => {
  const resolve = config.track?.success as ((data: TData | null, input: TInput) => DbTrackEvent | null | undefined) | undefined;
  emitConfiguredTrackEvent(resolve, [result, input], resolveCommandTrackLogPrefix(config), 'success');
};

export const emitCommandTrackError = <TInput, TData, TExtractSpec>(config: DbCommandMutationConfig<TInput, TData, TExtractSpec>, error: Error, input: TInput): void => {
  emitConfiguredTrackEvent(config.track?.error, [error, input], resolveCommandTrackLogPrefix(config), 'error');
};
