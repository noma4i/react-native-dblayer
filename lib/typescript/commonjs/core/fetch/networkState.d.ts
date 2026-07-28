/** Read the coordinator-owned connectivity state used by every fetch path. */
export declare const isFetchNetworkOnline: () => boolean;
/** Test and host adapter for coordinator connectivity changes. */
export declare const setFetchNetworkOnline: (nextOnline: boolean) => void;
/** Subscribe to coordinator connectivity changes. */
export declare const subscribeFetchNetwork: (listener: () => void) => (() => void);
//# sourceMappingURL=networkState.d.ts.map