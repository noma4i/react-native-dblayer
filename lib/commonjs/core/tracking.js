"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbTrackSink = exports.hasDbTrackSink = exports.emitDbTrackEvent = exports.emitConfiguredTrackEvent = void 0;
var _logger = require("./logger.js");
let currentDbTrackSink;

/** Set the sink used by declarative mutation and command tracking. */
const setDbTrackSink = sink => {
  currentDbTrackSink = sink;
};

/** Return true when declarative mutation and command tracking has an active sink. */
exports.setDbTrackSink = setDbTrackSink;
const hasDbTrackSink = () => currentDbTrackSink !== undefined;

/** Emit a track event if a sink is configured. */
exports.hasDbTrackSink = hasDbTrackSink;
const emitDbTrackEvent = (event, logPrefix, phase) => {
  if (!currentDbTrackSink) return;
  try {
    currentDbTrackSink(event);
  } catch (error) {
    (0, _logger.getDbLogger)().debug(logPrefix, 'track sink failed', phase, error);
  }
};

/** Resolve and emit a configured track event when a sink is active. */
exports.emitDbTrackEvent = emitDbTrackEvent;
const emitConfiguredTrackEvent = (resolve, args, logPrefix, phase) => {
  if (!currentDbTrackSink) return;
  if (!resolve) return;
  try {
    const event = resolve(...args);
    if (event) emitDbTrackEvent(event, logPrefix, phase);
  } catch (error) {
    (0, _logger.getDbLogger)().debug(logPrefix, 'track resolver failed', phase, error);
  }
};
exports.emitConfiguredTrackEvent = emitConfiguredTrackEvent;
//# sourceMappingURL=tracking.js.map