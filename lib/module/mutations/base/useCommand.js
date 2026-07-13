"use strict";

import { getDbExtractSink, getDbMutationExtractResolver } from "../../core/extract.js";
import { getDbTransport } from "../../core/transport.js";
import { emitCommandTrackError, emitCommandTrackStart, emitCommandTrackSuccess } from "./commandTracking.js";
import { capitalize } from "./mutationConfig.js";
import { useCommandMutation } from "./useCommandMutation.js";
const staticResultField = config => 'resultField' in config ? config.resultField : undefined;
const resolveCommandConfig = (config, input) => {
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
const applyCommandExtract = (config, result) => {
  if (!config.extract) return;
  getDbExtractSink()(getDbMutationExtractResolver()(config.extract, result), config.extractSource ?? 'mutation');
};

/**
 * Run a command mutation outside React without optimistic writes or invalidation.
 * @param config Same config accepted by `useCommand`; `key` and `logPrefix` are hook-only.
 * @param input Caller input.
 * @returns Command result field or null when the response field is missing.
 */
export const runDbCommandDirect = async (config, input) => {
  emitCommandTrackStart(config, input);
  try {
    const {
      mutation,
      resultField,
      mappedInput
    } = resolveCommandConfig(config, input);
    const result = await getDbTransport().mutation({
      mutation,
      variables: {
        input: mappedInput
      }
    });
    const selected = result.data[resultField] ?? null;
    applyCommandExtract(config, selected);
    emitCommandTrackSuccess(config, selected, input);
    return selected;
  } catch (error) {
    emitCommandTrackError(config, error, input);
    throw error;
  }
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
export const useCommand = config => useCommandMutation({
  key: config.key ?? (() => [staticResultField(config) ?? 'command']),
  logPrefix: config.logPrefix ?? (staticResultField(config) ? capitalize(staticResultField(config)) : undefined),
  dedupe: config.dedupe,
  mutationFn: input => runDbCommandDirect(config, input)
});
//# sourceMappingURL=useCommand.js.map