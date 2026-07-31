"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.subscribeFetchNetwork = exports.setFetchNetworkOnline = exports.isFetchNetworkOnline = exports.createOfflineFetchError = void 0;
/** Coordinator-owned connectivity state: the single source every fetch path and retry gate reads. */
const onlineListeners = new Set();
let online = true;

/** Read the coordinator-owned connectivity state used by every fetch path. */
const isFetchNetworkOnline = () => online;
exports.isFetchNetworkOnline = isFetchNetworkOnline;
const createOfflineFetchError = () => new Error('react-native-dblayer: fetch is offline and no cached data exists');

/**
 * Host connectivity input: the app reports reachability changes here (e.g. from a NetInfo
 * listener) and the coordinator pauses fetch paths and subscription retries while offline,
 * resuming them once connectivity returns. Idempotent for repeated same-value calls.
 *
 * @param nextOnline `true` when the device regained a usable network, `false` when it lost one.
 */
exports.createOfflineFetchError = createOfflineFetchError;
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