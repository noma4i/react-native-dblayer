import type { SingleFlightOptions, ThrottledSingleFlightOptions } from '../types';
/**
 * Coalesce concurrent calls and suppress calls inside the post-success interval.
 *
 * Suppressed calls and failed executions resolve to `undefined`.
 *
 * @param fn Async task to run at most once concurrently.
 * @param options Minimum post-success interval and optional force predicate.
 * @returns A wrapped function that shares in-flight work and resolves `undefined` for suppressed or failed calls.
 */
export declare const createThrottledSingleFlight: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options: ThrottledSingleFlightOptions<TArgs>) => ((...args: TArgs) => Promise<TResult | undefined>);
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
export declare const createSingleFlight: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>, options?: SingleFlightOptions) => ((...args: TArgs) => Promise<TResult>);
//# sourceMappingURL=singleFlight.d.ts.map