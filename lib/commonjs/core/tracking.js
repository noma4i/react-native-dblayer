"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbTrackSink = exports.hasDbTrackSink = exports.emitDbTrackEvent = exports.emitConfiguredTrackEvent = void 0;
var _logger = require("./logger.js");
var _configuredSlot = require("./configuredSlot.js");
const currentDbTrackSink = (0, _configuredSlot.createConfiguredSlot)(undefined);

/** Set the sink used by declarative mutation and command tracking. */
const setDbTrackSink = sink => {
  currentDbTrackSink.set(sink);
};

/** Return true when declarative mutation and command tracking has an active sink. */
exports.setDbTrackSink = setDbTrackSink;
const hasDbTrackSink = () => currentDbTrackSink.get() !== undefined;

/** Emit a track event if a sink is configured. */
exports.hasDbTrackSink = hasDbTrackSink;
const emitDbTrackEvent = (event, logPrefix, phase) => {
  const sink = currentDbTrackSink.get();
  if (!sink) return;
  try {
    sink(event);
  } catch (error) {
    (0, _logger.getDbLogger)().debug(logPrefix, 'track sink failed', phase, error);
  }
};

/** Resolve and emit a configured track event when a sink is active. */
exports.emitDbTrackEvent = emitDbTrackEvent;
const emitConfiguredTrackEvent = (resolve, args, logPrefix, phase) => {
  if (!currentDbTrackSink.get()) return;
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