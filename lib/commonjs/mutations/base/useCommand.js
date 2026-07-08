"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useCommand = exports.runDbCommandDirect = void 0;
var _extract = require("../../core/extract.js");
var _transport = require("../../core/transport.js");
var _commandTracking = require("./commandTracking.js");
var _mutationConfig = require("./mutationConfig.js");
var _useCommandMutation = require("./useCommandMutation.js");
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
  (0, _extract.getDbExtractSink)()((0, _extract.getDbMutationExtractResolver)()(config.extract, result), config.extractSource ?? 'mutation');
};

/**
 * Run a command mutation outside React without optimistic writes or invalidation.
 * @param config Same config accepted by `useCommand`; `key` and `logPrefix` are hook-only.
 * @param input Caller input.
 * @returns Command result field or null when the response field is missing.
 */
const runDbCommandDirect = async (config, input) => {
  (0, _commandTracking.emitCommandTrackStart)(config, input);
  try {
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
    const selected = result.data[resultField] ?? null;
    applyCommandExtract(config, selected);
    (0, _commandTracking.emitCommandTrackSuccess)(config, selected, input);
    return selected;
  } catch (error) {
    (0, _commandTracking.emitCommandTrackError)(config, error, input);
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
exports.runDbCommandDirect = runDbCommandDirect;
const useCommand = config => (0, _useCommandMutation.useCommandMutation)({
  key: config.key ?? (() => [staticResultField(config) ?? 'command']),
  logPrefix: config.logPrefix ?? (staticResultField(config) ? (0, _mutationConfig.capitalize)(staticResultField(config)) : undefined),
  singleFlightInput: input => resolveCommandConfig(config, input).mappedInput,
  mutationFn: input => runDbCommandDirect(config, input)
});
exports.useCommand = useCommand;
//# sourceMappingURL=useCommand.js.map