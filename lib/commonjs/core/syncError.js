"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.reportSyncError = void 0;
var _configure = require("../dsl/configure.js");
var _logger = require("./logger.js");
/** Report one contained pipeline failure without allowing either the observer or logger to alter control flow. */
const reportSyncError = (error, context, owner) => {
  const reported = error instanceof Error ? error : new Error(String(error));
  try {
    (0, _configure.getDbRuntimeConfig)().defaults.onSyncError?.(reported, context);
  } catch (observerError) {
    try {
      (0, _logger.getDbLogger)().error(`${owner} onSyncError failed`, {
        error: observerError
      });
    } catch {
      // Error observers and loggers cannot change the owning pipeline's outcome.
    }
  }
  return reported;
};
exports.reportSyncError = reportSyncError;
//# sourceMappingURL=syncError.js.map