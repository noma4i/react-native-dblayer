"use strict";

import { emitConfiguredTrackEvent } from "../../core/tracking.js";
import { capitalize } from "./mutationConfig.js";
const resolveCommandTrackLogPrefix = config => config.logPrefix ?? (typeof config.resultField === 'string' ? capitalize(config.resultField) : 'Command');
export const emitCommandTrackStart = (config, input) => {
  emitConfiguredTrackEvent(config.track?.start, [input], resolveCommandTrackLogPrefix(config), 'start');
};
export const emitCommandTrackSuccess = (config, result, input) => {
  const resolve = config.track?.success;
  emitConfiguredTrackEvent(resolve, [result, input], resolveCommandTrackLogPrefix(config), 'success');
};
export const emitCommandTrackError = (config, error, input) => {
  emitConfiguredTrackEvent(config.track?.error, [error, input], resolveCommandTrackLogPrefix(config), 'error');
};
//# sourceMappingURL=commandTracking.js.map