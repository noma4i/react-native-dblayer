"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.emitMutationTrackSuccess = exports.emitMutationTrackStart = exports.emitMutationTrackError = void 0;
var _tracking = require("../../core/tracking.js");
var _mutationConfig = require("./mutationConfig.js");
const emitMutationTrackStart = (config, input) => {
  (0, _tracking.emitConfiguredTrackEvent)(config.track?.start, [input], (0, _mutationConfig.resolveMutationLogPrefix)(config), 'start');
};
exports.emitMutationTrackStart = emitMutationTrackStart;
const emitMutationTrackSuccess = (config, result, input, context) => {
  const resolve = config.track?.success;
  (0, _tracking.emitConfiguredTrackEvent)(resolve, [result, input, context], (0, _mutationConfig.resolveMutationLogPrefix)(config), 'success');
};
exports.emitMutationTrackSuccess = emitMutationTrackSuccess;
const emitMutationTrackError = (config, error, input) => {
  (0, _tracking.emitConfiguredTrackEvent)(config.track?.error, [error, input], (0, _mutationConfig.resolveMutationLogPrefix)(config), 'error');
};
exports.emitMutationTrackError = emitMutationTrackError;
//# sourceMappingURL=mutationTracking.js.map