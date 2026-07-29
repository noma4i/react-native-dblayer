"use strict";

import { isRecord } from "./normalizeHelpers.js";
import { registerReset } from "../core/reset.js";
const defaultIsForced = arg => isRecord(arg) && arg.force === true;

/**
 * Coalesce concurrent calls and suppress calls inside the post-success interval.
 *
 * Suppressed calls and failed executions resolve to `undefined`.
 *
 * @param fn Async task to run at most once concurrently.
 * @param options Minimum post-success interval and optional force predicate.
 * @returns A wrapped function that shares in-flight work and resolves `undefined` for suppressed or failed calls.
 */
export const createThrottledSingleFlight = (fn, options) => {
  let inFlight = null;
  let lastSuccessAt = 0;
  if (options.resetOnRuntimeReset) {
    registerReset(() => {
      inFlight = null;
      lastSuccessAt = 0;
    });
  }
  return (...args) => {
    if (inFlight) return inFlight;
    const force = options.isForced ? options.isForced(...args) : defaultIsForced(args[0]);
    if (!force && Date.now() - lastSuccessAt < options.minIntervalMs) {
      return Promise.resolve(undefined);
    }
    try {
      inFlight = fn(...args).then(result => {
        lastSuccessAt = Date.now();
        return result;
      }).catch(() => undefined).finally(() => {
        inFlight = null;
      });
    } catch {
      inFlight = Promise.resolve(undefined).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
};

/**
 * Wraps an async function so concurrent callers share one in-flight promise.
 * Unlike createThrottledSingleFlight this primitive has no throttle window and
 * PROPAGATES rejections to every caller sharing the flight - use it when the
 * caller must observe failures (bootstrap fetches, config loads).
 *
 * @param fn Async function to wrap.
 * @param options Optional reset control when runtime resets should clear the in-flight state.
 * @returns Function that shares the current in-flight promise across concurrent callers.
 */
export const createSingleFlight = (fn, options) => {
  let inFlight = null;
  if (options?.resetOnRuntimeReset) {
    registerReset(() => {
      inFlight = null;
    });
  }
  return (...args) => {
    if (inFlight) return inFlight;
    const flight = fn(...args).finally(() => {
      if (inFlight === flight) inFlight = null;
    });
    inFlight = flight;
    return flight;
  };
};
//# sourceMappingURL=singleFlight.js.map