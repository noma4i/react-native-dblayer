"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useCommand = exports.runDbCommandDirect = void 0;
var _transport = require("../../core/transport.js");
var _useCommandMutation = require("./useCommandMutation.js");
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
 * Run a command mutation outside React without optimistic writes or invalidation.
 * @param config Same config accepted by `useCommand`; `key` and `logPrefix` are hook-only.
 * @param input Caller input.
 * @returns Command result field or null when the response field is missing.
 */
const runDbCommandDirect = async (config, input) => {
  const {
    mutation,
    resultField,
    mappedInput
  } = resolveCommandConfig(config, input);
  const result = await (0, _transport.getDbTransport)().mutation({
    mutation,
    variables: {
      input: mappedInput
    }
  });
  return result.data[resultField] ?? null;
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
exports.runDbCommandDirect = runDbCommandDirect;
const useCommand = config => (0, _useCommandMutation.useCommandMutation)({
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
    const result = await (0, _transport.getDbTransport)().mutation({
      mutation,
      variables
    });
    return result.data[resultField];
  }
});
exports.useCommand = useCommand;
//# sourceMappingURL=useCommand.js.map