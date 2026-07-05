"use strict";

const noop = () => {};
const defaultDbLogger = {
  debug: noop,
  error: noop
};
let currentDbLogger = defaultDbLogger;

/** Set the logger used by request and mutation runtimes. */
export const setDbLogger = logger => {
  currentDbLogger = logger;
};

/** Get the currently configured logger. */
export const getDbLogger = () => currentDbLogger;
//# sourceMappingURL=logger.js.map