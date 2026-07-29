"use strict";

import { getDbRuntimeConfig } from "../dsl/configure.js";
import { getDbLogger } from "./logger.js";

/** Report one contained pipeline failure without allowing either the observer or logger to alter control flow. */
export const reportSyncError = (error, context, owner) => {
  const reported = error instanceof Error ? error : new Error(String(error));
  try {
    getDbRuntimeConfig().defaults.onSyncError?.(reported, context);
  } catch (observerError) {
    try {
      getDbLogger().error(`${owner} onSyncError failed`, {
        error: observerError
      });
    } catch {
      // Error observers and loggers cannot change the owning pipeline's outcome.
    }
  }
  return reported;
};
//# sourceMappingURL=syncError.js.map