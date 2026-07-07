"use strict";

import { getDbLogger } from "../../core/logger.js";
import { emitDbTrackEvent, hasDbTrackSink } from "../../core/tracking.js";
const emitResolvedTrackEvent = (event, logPrefix, phase) => {
  if (!event) return;
  emitDbTrackEvent(event, logPrefix, phase);
};
export const emitMutationTrackStart = (config, input) => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.start;
  if (!resolve) return;
  try {
    emitResolvedTrackEvent(resolve(input), config.logPrefix, 'start');
  } catch (error) {
    getDbLogger().debug(config.logPrefix, 'track resolver failed', 'start', error);
  }
};
export const emitMutationTrackSuccess = (config, result, input, context) => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.success;
  if (!resolve) return;
  try {
    emitResolvedTrackEvent(resolve(result, input, context), config.logPrefix, 'success');
  } catch (error) {
    getDbLogger().debug(config.logPrefix, 'track resolver failed', 'success', error);
  }
};
export const emitMutationTrackError = (config, error, input) => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.error;
  if (!resolve) return;
  try {
    emitResolvedTrackEvent(resolve(error, input), config.logPrefix, 'error');
  } catch (trackError) {
    getDbLogger().debug(config.logPrefix, 'track resolver failed', 'error', trackError);
  }
};
//# sourceMappingURL=mutationTracking.js.map