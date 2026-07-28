"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.subscribeFetchNetwork = exports.setFetchNetworkOnline = exports.isFetchNetworkOnline = void 0;
/** Coordinator-owned connectivity state: the single source every fetch path and retry gate reads. */
const onlineListeners = new Set();
let online = true;

/** Read the coordinator-owned connectivity state used by every fetch path. */
const isFetchNetworkOnline = () => online;

/** Test and host adapter for coordinator connectivity changes. */
exports.isFetchNetworkOnline = isFetchNetworkOnline;
const setFetchNetworkOnline = nextOnline => {
  if (online === nextOnline) return;
  online = nextOnline;
  for (const listener of onlineListeners) listener();
};

/** Subscribe to coordinator connectivity changes. */
exports.setFetchNetworkOnline = setFetchNetworkOnline;
const subscribeFetchNetwork = listener => {
  onlineListeners.add(listener);
  return () => onlineListeners.delete(listener);
};
exports.subscribeFetchNetwork = subscribeFetchNetwork;
//# sourceMappingURL=networkState.js.map