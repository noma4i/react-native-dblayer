import type { DbCommandMutationConfig, DbGraphQLDocument } from '../../types';
import { getDbTransport } from '../../core/transport';
import { useCommandMutation } from './useCommandMutation';

const resolveCommandConfig = <TData, TInput>(
  config: DbCommandMutationConfig<TInput, TData>,
  input: TInput
): { mutation: DbGraphQLDocument<Record<string, TData>, { input: unknown }>; resultField: string; mappedInput: unknown } => {
  if (config.resolve) {
    const resolvedCommand = config.resolve(input);
    const hasMappedInput = Object.prototype.hasOwnProperty.call(resolvedCommand, 'input');
    return {
      mutation: resolvedCommand.mutation,
      resultField: resolvedCommand.resultField,
      mappedInput: hasMappedInput ? resolvedCommand.input : input
    };
  }

  return {
    mutation: config.mutation,
    resultField: config.resultField,
    mappedInput: config.mapInput ? config.mapInput(input) : input
  };
};

/**
 * React hook for fire-and-forget GraphQL commands without optimistic writes.
 * @param config Static or per-input command mutation config.
 * @returns React Query mutation result.
 *
 * @example
 * const track = useCommand({
 *   key: () => ['trackEvent'],
 *   logPrefix: 'trackEvent',
 *   mutation: TRACK_EVENT,
 *   resultField: 'trackEvent'
 * });
 */
export const useCommand = <TData, TInput>(config: DbCommandMutationConfig<TInput, TData>) =>
  useCommandMutation<TData, TInput>({
    key: config.key,
    logPrefix: config.logPrefix,
    singleFlightInput: input => resolveCommandConfig(config, input).mappedInput,
    mutationFn: async (input: TInput) => {
      const { mutation, resultField, mappedInput } = resolveCommandConfig(config, input);
      const variables = { input: mappedInput };
      const result = await getDbTransport().mutation<Record<string, TData>, { input: unknown }>({
        mutation,
        variables
      });
      return result.data[resultField];
    }
  });
