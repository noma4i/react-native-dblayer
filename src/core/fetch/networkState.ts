/** Coordinator-owned connectivity state: the single source every fetch path and retry gate reads. */
const onlineListeners = new Set<() => void>();
let online = true;

/** Read the coordinator-owned connectivity state used by every fetch path. */
export const isFetchNetworkOnline = (): boolean => online;

/** Test and host adapter for coordinator connectivity changes. */
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
