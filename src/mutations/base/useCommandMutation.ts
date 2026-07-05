import { useMutation } from '@tanstack/react-query';
import type { DbCommandConfig } from '../../types';
import { getDbLogger } from '../../core/logger';
import { createSingleFlightSignature, runSingleFlight } from './singleFlight';

/**
 * React hook primitive for command-style mutations with single-flight dedupe.
 * @param config Command mutation function, key, logging, and lifecycle callbacks.
 * @returns React Query mutation result.
 */
export const useCommandMutation = <TData, TInput>(config: DbCommandConfig<TData, TInput>) =>
  useMutation<TData, Error, TInput>({
    mutationKey: config.key(),
    mutationFn: (input: TInput) => {
      const singleFlightInput = config.singleFlightInput ? config.singleFlightInput(input) : input;
      const singleFlightSignature = createSingleFlightSignature('command-mutation', config.key(), singleFlightInput);

      return runSingleFlight(singleFlightSignature, () => {
        getDbLogger().debug(config.logPrefix, 'mutationFn start');
        return config.mutationFn(input);
      });
    },
    onSuccess: (data, input) => {
      config.onSuccess?.(data, input);
    },
    onError: (error, input) => {
      config.onError?.(error, input);
      getDbLogger().error(config.logPrefix, 'onError', error);
    },
    onSettled: () => {
      config.onSettled?.();
    }
  });
