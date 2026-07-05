"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.setDbLogger = exports.getDbLogger = void 0;
const noop = () => {};
const defaultDbLogger = {
  debug: noop,
  error: noop
};
let currentDbLogger = defaultDbLogger;

/** Set the logger used by request and mutation runtimes. */
const setDbLogger = logger => {
  currentDbLogger = logger;
};

/** Get the currently configured logger. */
exports.setDbLogger = setDbLogger;
const getDbLogger = () => currentDbLogger;
exports.getDbLogger = getDbLogger;
//# sourceMappingURL=logger.js.map