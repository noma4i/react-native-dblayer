"use strict";

import { getDbTransport } from "../../core/transport.js";
import { useCommandMutation } from "./useCommandMutation.js";
const capitalize = value => value ? value[0].toUpperCase() + value.slice(1) : value;
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
  singleFlightInput: input => resolveCommandConfig(config, input).mappedInput,
  mutationFn: async input => {
    const {
      mutation,
      resultField,
      mappedInput
    } = resolveCommandConfig(config, input);
    const variables = {
      input: mappedInput
    };
    const result = await getDbTransport().mutation({
      mutation,
      variables
    });
    return result.data[resultField];
  }
});
//# sourceMappingURL=useCommand.js.map