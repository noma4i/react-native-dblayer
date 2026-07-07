"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.emitMutationTrackSuccess = exports.emitMutationTrackStart = exports.emitMutationTrackError = void 0;
var _logger = require("../../core/logger.js");
var _tracking = require("../../core/tracking.js");
var _mutationConfig = require("./mutationConfig.js");
const emitResolvedTrackEvent = (event, logPrefix, phase) => {
  if (!event) return;
  (0, _tracking.emitDbTrackEvent)(event, logPrefix, phase);
};
const emitMutationTrackStart = (config, input) => {
  if (!(0, _tracking.hasDbTrackSink)()) return;
  const resolve = config.track?.start;
  if (!resolve) return;
  const logPrefix = (0, _mutationConfig.resolveMutationLogPrefix)(config);
  try {
    emitResolvedTrackEvent(resolve(input), logPrefix, 'start');
  } catch (error) {
    (0, _logger.getDbLogger)().debug(logPrefix, 'track resolver failed', 'start', error);
  }
};
exports.emitMutationTrackStart = emitMutationTrackStart;
const emitMutationTrackSuccess = (config, result, input, context) => {
  if (!(0, _tracking.hasDbTrackSink)()) return;
  const resolve = config.track?.success;
  if (!resolve) return;
  const logPrefix = (0, _mutationConfig.resolveMutationLogPrefix)(config);
  try {
    emitResolvedTrackEvent(resolve(result, input, context), logPrefix, 'success');
  } catch (error) {
    (0, _logger.getDbLogger)().debug(logPrefix, 'track resolver failed', 'success', error);
  }
};
exports.emitMutationTrackSuccess = emitMutationTrackSuccess;
const emitMutationTrackError = (config, error, input) => {
  if (!(0, _tracking.hasDbTrackSink)()) return;
  const resolve = config.track?.error;
  if (!resolve) return;
  const logPrefix = (0, _mutationConfig.resolveMutationLogPrefix)(config);
  try {
    emitResolvedTrackEvent(resolve(error, input), logPrefix, 'error');
  } catch (trackError) {
    (0, _logger.getDbLogger)().debug(logPrefix, 'track resolver failed', 'error', trackError);
  }
};
exports.emitMutationTrackError = emitMutationTrackError;
//# sourceMappingURL=mutationTracking.js.map