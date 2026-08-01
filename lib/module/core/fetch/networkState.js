"use strict";

import { onlineManager } from '@tanstack/react-query';

/**
 * Connectivity has one owner, and it is React Query's. A second copy of the same boolean meant two
 * answers to one question, and the retry gate, the fetch paths and the subscription runtime could
 * each be told a different one.
 *
 * The fetch paths still ask before starting rather than letting the query runtime pause them:
 * `networkMode` stays `'always'` because an imperative `fetch()` must fail while offline instead of
 * returning a promise that settles whenever the network happens to come back.
 */

/** Read the connectivity state used by every fetch path. */
export const isFetchNetworkOnline = () => onlineManager.isOnline();

/** Build the error an imperative fetch throws when it is offline with nothing cached to return. */
export const createOfflineFetchError = () => new Error('react-native-dblayer: fetch is offline and no cached data exists');

/**
 * Host connectivity input: the app reports reachability changes here (e.g. from a NetInfo
 * listener) and the coordinator pauses fetch paths and subscription retries while offline,
 * resuming them once connectivity returns. Idempotent for repeated same-value calls.
 *
 * @param nextOnline `true` when the device regained a usable network, `false` when it lost one.
 * @returns Nothing.
 */
export const setFetchNetworkOnline = nextOnline => {
  onlineManager.setOnline(nextOnline);
};

/**
 * Subscribe to connectivity changes.
 *
 * @param listener Called after every change of the connectivity state.
 * @returns The unsubscribe callback.
 */
export const subscribeFetchNetwork = listener => onlineManager.subscribe(() => listener());
//# sourceMappingURL=networkState.js.map