"use strict";

import { getDbLogger } from "./logger.js";
let currentDbTrackSink;

/** Set the sink used by declarative mutation tracking. */
export const setDbTrackSink = sink => {
  currentDbTrackSink = sink;
};

/** Return true when declarative mutation tracking has an active sink. */
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
//# sourceMappingURL=tracking.js.map