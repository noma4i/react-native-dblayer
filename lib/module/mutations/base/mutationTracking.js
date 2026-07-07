"use strict";

import { getDbLogger } from "../../core/logger.js";
import { emitDbTrackEvent, hasDbTrackSink } from "../../core/tracking.js";
import { resolveMutationLogPrefix } from "./mutationConfig.js";
const emitResolvedTrackEvent = (event, logPrefix, phase) => {
  if (!event) return;
  emitDbTrackEvent(event, logPrefix, phase);
};
export const emitMutationTrackStart = (config, input) => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.start;
  if (!resolve) return;
  const logPrefix = resolveMutationLogPrefix(config);
  try {
    emitResolvedTrackEvent(resolve(input), logPrefix, 'start');
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track resolver failed', 'start', error);
  }
};
export const emitMutationTrackSuccess = (config, result, input, context) => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.success;
  if (!resolve) return;
  const logPrefix = resolveMutationLogPrefix(config);
  try {
    emitResolvedTrackEvent(resolve(result, input, context), logPrefix, 'success');
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track resolver failed', 'success', error);
  }
};
export const emitMutationTrackError = (config, error, input) => {
  if (!hasDbTrackSink()) return;
  const resolve = config.track?.error;
  if (!resolve) return;
  const logPrefix = resolveMutationLogPrefix(config);
  try {
    emitResolvedTrackEvent(resolve(error, input), logPrefix, 'error');
  } catch (trackError) {
    getDbLogger().debug(logPrefix, 'track resolver failed', 'error', trackError);
  }
};
//# sourceMappingURL=mutationTracking.js.map