"use strict";

import { getDbLogger } from "./logger.js";
let currentDbTrackSink;

/** Set the sink used by declarative mutation and command tracking. */
export const setDbTrackSink = sink => {
  currentDbTrackSink = sink;
};

/** Return true when declarative mutation and command tracking has an active sink. */
export const hasDbTrackSink = () => currentDbTrackSink !== undefined;

/** Emit a track event if a sink is configured. */
export const emitDbTrackEvent = (event, logPrefix, phase) => {
  if (!currentDbTrackSink) return;
  try {
    currentDbTrackSink(event);
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track sink failed', phase, error);
  }
};

/** Resolve and emit a configured track event when a sink is active. */
export const emitConfiguredTrackEvent = (resolve, args, logPrefix, phase) => {
  if (!currentDbTrackSink) return;
  if (!resolve) return;
  try {
    const event = resolve(...args);
    if (event) emitDbTrackEvent(event, logPrefix, phase);
  } catch (error) {
    getDbLogger().debug(logPrefix, 'track resolver failed', phase, error);
  }
};
//# sourceMappingURL=tracking.js.map