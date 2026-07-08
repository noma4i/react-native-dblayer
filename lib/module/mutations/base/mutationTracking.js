"use strict";

import { emitConfiguredTrackEvent } from "../../core/tracking.js";
import { resolveMutationLogPrefix } from "./mutationConfig.js";
export const emitMutationTrackStart = (config, input) => {
  emitConfiguredTrackEvent(config.track?.start, [input], resolveMutationLogPrefix(config), 'start');
};
export const emitMutationTrackSuccess = (config, result, input, context) => {
  const resolve = config.track?.success;
  emitConfiguredTrackEvent(resolve, [result, input, context], resolveMutationLogPrefix(config), 'success');
};
export const emitMutationTrackError = (config, error, input) => {
  emitConfiguredTrackEvent(config.track?.error, [error, input], resolveMutationLogPrefix(config), 'error');
};
//# sourceMappingURL=mutationTracking.js.map