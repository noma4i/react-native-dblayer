import { useMutation } from '@tanstack/react-query';
import type { DbCommandConfig } from '../../types';
import { getDbLogger } from '../../core/logger';
import { resolveCommandKey, resolveCommandLogPrefix } from './mutationConfig';
import { createSingleFlightSignature, runSingleFlight } from './singleFlight';

/**
 * React hook primitive for command-style mutations with opt-in single-flight dedupe.
 * @param config Command mutation function, key, logging, and lifecycle callbacks.
 * @returns React Query mutation result.
 */
export const useCommandMutation = <TData, TInput>(config: DbCommandConfig<TData, TInput>) =>
  useMutation<TData, Error, TInput>({
    mutationKey: resolveCommandKey(config),
    mutationFn: (input: TInput) => {
      const commandKey = resolveCommandKey(config);
      const logPrefix = resolveCommandLogPrefix(config);

      const executeCommand = (): Promise<TData> => {
        getDbLogger().debug(logPrefix, 'mutationFn start');
        return config.mutationFn(input);
      };

      const dedupeKey = config.dedupe?.key(input);
      if (dedupeKey == null) {
        return executeCommand();
      }

      return runSingleFlight(createSingleFlightSignature('command-mutation', commandKey, dedupeKey), executeCommand);
    },
    onSuccess: (data, input) => {
      config.onSuccess?.(data, input);
    },
    onError: (error, input) => {
      config.onError?.(error, input);
      getDbLogger().error(resolveCommandLogPrefix(config), 'onError', error);
    },
    onSettled: () => {
      config.onSettled?.();
    }
  });
