"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbTrackSink = exports.hasDbTrackSink = exports.emitDbTrackEvent = void 0;
var _logger = require("./logger.js");
let currentDbTrackSink;

/** Set the sink used by declarative mutation tracking. */
const setDbTrackSink = sink => {
  currentDbTrackSink = sink;
};

/** Return true when declarative mutation tracking has an active sink. */
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
exports.emitDbTrackEvent = emitDbTrackEvent;
//# sourceMappingURL=tracking.js.map