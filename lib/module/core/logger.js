"use strict";

import { createConfiguredSlot } from "./configuredSlot.js";
const noop = () => {};
const defaultDbLogger = {
  debug: noop,
  error: noop
};
const currentDbLogger = createConfiguredSlot(defaultDbLogger);

/** Set the logger used by request and mutation runtimes. */
export const setDbLogger = logger => {
  currentDbLogger.set(logger);
};

/** Get the currently configured logger. */
export const getDbLogger = () => currentDbLogger.get();
//# sourceMappingURL=logger.js.map