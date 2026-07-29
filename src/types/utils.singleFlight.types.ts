export type ThrottledSingleFlightOptions<TArgs extends unknown[]> = {
  minIntervalMs: number;
  /** Override throttle suppression; defaults to reading `args[0].force === true`. */
  isForced?: (...args: TArgs) => boolean;
  /** Clear the in-flight slot and the post-success throttle window on runtime reset so a stale window never suppresses post-reset callers. */
  resetOnRuntimeReset?: boolean;
};

export type SingleFlightOptions = {
  /** Clear the shared in-flight promise on runtime reset so a stale fetch never satisfies post-reset callers. */
  resetOnRuntimeReset?: boolean;
};
