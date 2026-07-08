import type { DbCommandMutationConfig, DbGraphQLDocument } from '../../types';
import { getDbExtractSink, getDbMutationExtractResolver } from '../../core/extract';
import { getDbTransport } from '../../core/transport';
import { capitalize } from './mutationConfig';
import { useCommandMutation } from './useCommandMutation';

const staticResultField = <TData, TInput>(config: DbCommandMutationConfig<TInput, TData>): string | undefined => ('resultField' in config ? config.resultField : undefined);

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

const applyCommandExtract = <TData, TInput>(config: DbCommandMutationConfig<TInput, TData>, result: TData | null): void => {
  if (!config.extract) return;
  getDbExtractSink()(getDbMutationExtractResolver()(config.extract, result), config.extractSource ?? 'mutation');
};

/**
 * Run a command mutation outside React without optimistic writes or invalidation.
 * @param config Same config accepted by `useCommand`; `key` and `logPrefix` are hook-only.
 * @param input Caller input.
 * @returns Command result field or null when the response field is missing.
 */
export const runDbCommandDirect = async <TData, TInput>(config: DbCommandMutationConfig<TInput, TData>, input: TInput): Promise<TData | null> => {
  const { mutation, resultField, mappedInput } = resolveCommandConfig(config, input);
  const result = await getDbTransport().mutation<Record<string, TData>, { input: unknown }>({
    mutation,
    variables: { input: mappedInput }
  });
  const selected = result.data[resultField] ?? null;
  applyCommandExtract(config, selected);
  return selected;
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
    key: config.key ?? (() => [staticResultField(config) ?? 'command']),
    logPrefix: config.logPrefix ?? (staticResultField(config) ? capitalize(staticResultField(config)!) : undefined),
    singleFlightInput: input => resolveCommandConfig(config, input).mappedInput,
    mutationFn: async (input: TInput) => {
      const { mutation, resultField, mappedInput } = resolveCommandConfig(config, input);
      const variables = { input: mappedInput };
      const result = await getDbTransport().mutation<Record<string, TData>, { input: unknown }>({
        mutation,
        variables
      });
      const selected = result.data[resultField];
      applyCommandExtract(config, selected ?? null);
      return selected;
    }
  });
