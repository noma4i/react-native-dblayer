"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.emitCommandTrackSuccess = exports.emitCommandTrackStart = exports.emitCommandTrackError = void 0;
var _tracking = require("../../core/tracking.js");
var _mutationConfig = require("./mutationConfig.js");
const resolveCommandTrackLogPrefix = config => config.logPrefix ?? (typeof config.resultField === 'string' ? (0, _mutationConfig.capitalize)(config.resultField) : 'Command');
const emitCommandTrackStart = (config, input) => {
  (0, _tracking.emitConfiguredTrackEvent)(config.track?.start, [input], resolveCommandTrackLogPrefix(config), 'start');
};
exports.emitCommandTrackStart = emitCommandTrackStart;
const emitCommandTrackSuccess = (config, result, input) => {
  const resolve = config.track?.success;
  (0, _tracking.emitConfiguredTrackEvent)(resolve, [result, input], resolveCommandTrackLogPrefix(config), 'success');
};
exports.emitCommandTrackSuccess = emitCommandTrackSuccess;
const emitCommandTrackError = (config, error, input) => {
  (0, _tracking.emitConfiguredTrackEvent)(config.track?.error, [error, input], resolveCommandTrackLogPrefix(config), 'error');
};
exports.emitCommandTrackError = emitCommandTrackError;
//# sourceMappingURL=commandTracking.js.map