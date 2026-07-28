export type ThrottledSingleFlightOptions<TArgs extends unknown[]> = {
    minIntervalMs: number;
    /** Override throttle suppression; defaults to reading `args[0].force === true`. */
    isForced?: (...args: TArgs) => boolean;
};
export type SingleFlightOptions = {
    /** Clear the shared in-flight promise on runtime reset so a stale fetch never satisfies post-reset callers. */
    resetOnRuntimeReset?: boolean;
};
//# sourceMappingURL=utils.singleFlight.types.d.ts.map