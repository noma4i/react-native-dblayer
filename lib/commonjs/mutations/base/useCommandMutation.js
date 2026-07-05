"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useCommandMutation = void 0;
var _reactQuery = require("@tanstack/react-query");
var _logger = require("../../core/logger.js");
var _singleFlight = require("./singleFlight.js");
/**
 * React hook primitive for command-style mutations with single-flight dedupe.
 * @param config Command mutation function, key, logging, and lifecycle callbacks.
 * @returns React Query mutation result.
 */
const useCommandMutation = config => (0, _reactQuery.useMutation)({
  mutationKey: config.key(),
  mutationFn: input => {
    const singleFlightInput = config.singleFlightInput ? config.singleFlightInput(input) : input;
    const singleFlightSignature = (0, _singleFlight.createSingleFlightSignature)('command-mutation', config.key(), singleFlightInput);
    return (0, _singleFlight.runSingleFlight)(singleFlightSignature, () => {
      (0, _logger.getDbLogger)().debug(config.logPrefix, 'mutationFn start');
      return config.mutationFn(input);
    });
  },
  onSuccess: (data, input) => {
    config.onSuccess?.(data, input);
  },
  onError: (error, input) => {
    config.onError?.(error, input);
    (0, _logger.getDbLogger)().error(config.logPrefix, 'onError', error);
  },
  onSettled: () => {
    config.onSettled?.();
  }
});
exports.useCommandMutation = useCommandMutation;
//# sourceMappingURL=useCommandMutation.js.map