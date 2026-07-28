/** Coordinator-owned connectivity state: the single source every fetch path and retry gate reads. */
const onlineListeners = new Set<() => void>();
let online = true;

/** Read the coordinator-owned connectivity state used by every fetch path. */
export const isFetchNetworkOnline = (): boolean => online;

/**
 * Host connectivity input: the app reports reachability changes here (e.g. from a NetInfo
 * listener) and the coordinator pauses fetch paths and subscription retries while offline,
 * resuming them once connectivity returns. Idempotent for repeated same-value calls.
 *
 * @param nextOnline `true` when the device regained a usable network, `false` when it lost one.
 */
export const setFetchNetworkOnline = (nextOnline: boolean): void => {
  if (online === nextOnline) return;
  online = nextOnline;
  for (const listener of onlineListeners) listener();
};

/** Subscribe to coordinator connectivity changes. */
export const subscribeFetchNetwork = (listener: () => void): (() => void) => {
  onlineListeners.add(listener);
  return () => onlineListeners.delete(listener);
};
