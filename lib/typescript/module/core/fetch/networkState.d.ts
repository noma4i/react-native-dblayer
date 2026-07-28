/** Read the coordinator-owned connectivity state used by every fetch path. */
export declare const isFetchNetworkOnline: () => boolean;
/**
 * Host connectivity input: the app reports reachability changes here (e.g. from a NetInfo
 * listener) and the coordinator pauses fetch paths and subscription retries while offline,
 * resuming them once connectivity returns. Idempotent for repeated same-value calls.
 *
 * @param nextOnline `true` when the device regained a usable network, `false` when it lost one.
 */
export declare const setFetchNetworkOnline: (nextOnline: boolean) => void;
/** Subscribe to coordinator connectivity changes. */
export declare const subscribeFetchNetwork: (listener: () => void) => (() => void);
//# sourceMappingURL=networkState.d.ts.map