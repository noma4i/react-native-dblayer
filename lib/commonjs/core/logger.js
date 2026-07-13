"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbLogger = exports.getDbLogger = void 0;
var _configuredSlot = require("./configuredSlot.js");
const noop = () => {};
const defaultDbLogger = {
  debug: noop,
  error: noop
};
const currentDbLogger = (0, _configuredSlot.createConfiguredSlot)(defaultDbLogger);

/** Set the logger used by request and mutation runtimes. */
const setDbLogger = logger => {
  currentDbLogger.set(logger);
};

/** Get the currently configured logger. */
exports.setDbLogger = setDbLogger;
const getDbLogger = () => currentDbLogger.get();
exports.getDbLogger = getDbLogger;
//# sourceMappingURL=logger.js.map