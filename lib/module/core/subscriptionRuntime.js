"use strict";

import { getDbLogger } from "./logger.js";
import { getDbTransport } from "./transport.js";
const LOG_PREFIX = 'DbSubscriptionRuntime';
const GLOBAL_DEBOUNCE_KEY = '__global__';
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

/**
 * Static subscription registration consumed by `createDbSubscriptionRuntime`.
 *
 * @template TPayload Payload object under `responseData[key]`.
 */

/** Runtime inspection row for a registered subscription entry. */

/** Runtime controller returned by `createDbSubscriptionRuntime`. */

const isRecordPayload = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const nextRetryDelay = attempts => Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempts), MAX_RETRY_DELAY_MS);
const clearDebounceBuckets = state => {
  state.debounceBuckets.forEach(bucket => clearTimeout(bucket.timer));
  state.debounceBuckets.clear();
};
const clearRetryTimer = state => {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
};
const unsubscribeEntry = state => {
  const unsubscribe = state.unsubscribe;
  state.unsubscribe = null;
  if (unsubscribe) {
    unsubscribe();
  }
};

/**
 * Create a plain subscription runtime over the configured DB transport.
 *
 * @param entries Static subscription entries. Variables are read once from each entry when subscribing.
 * @returns Runtime controller for activation, manual dispatch, inspection, and teardown.
 */
export const createDbSubscriptionRuntime = entries => {
  const states = entries.map(entry => ({
    entry,
    unsubscribe: null,
    debounceBuckets: new Map(),
    retryTimer: null,
    retryAttempts: 0,
    eventCount: 0,
    lastEventAt: null,
    errorCount: 0
  }));
  const byKey = new Map(states.map(state => [state.entry.key, state]));
  let active = false;
  const runHandler = (state, payload) => {
    state.entry.onData(payload);
  };
  const handlePayload = (state, payload) => {
    if (!isRecordPayload(payload)) {
      getDbLogger().debug(LOG_PREFIX, 'payload skipped', {
        key: state.entry.key
      });
      return;
    }
    state.retryAttempts = 0;
    state.eventCount += 1;
    state.lastEventAt = Date.now();
    const debounce = state.entry.debounce;
    if (!debounce) {
      runHandler(state, payload);
      return;
    }
    const bucketKey = debounce.keyOf?.(payload) ?? GLOBAL_DEBOUNCE_KEY;
    const previous = state.debounceBuckets.get(bucketKey);
    if (previous) {
      clearTimeout(previous.timer);
    }
    const timer = setTimeout(() => {
      const bucket = state.debounceBuckets.get(bucketKey);
      if (!bucket) return;
      state.debounceBuckets.delete(bucketKey);
      runHandler(state, bucket.payload);
    }, debounce.ms);
    state.debounceBuckets.set(bucketKey, {
      timer,
      payload
    });
  };
  const handleTransportNext = (state, data) => {
    if (!isRecordPayload(data)) {
      getDbLogger().debug(LOG_PREFIX, 'response skipped', {
        key: state.entry.key
      });
      return;
    }
    handlePayload(state, data[state.entry.key]);
  };
  const subscribeEntry = state => {
    if (!active || state.unsubscribe) return;
    clearRetryTimer(state);
    const subscribe = getDbTransport().subscribe;
    if (!subscribe) {
      throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
    }
    state.unsubscribe = subscribe({
      query: state.entry.query,
      variables: state.entry.vars
    }, {
      next: data => handleTransportNext(state, data),
      error: error => handleEntryError(state, error)
    });
  };
  const scheduleRetry = state => {
    if (!active) return;
    clearRetryTimer(state);
    const delay = nextRetryDelay(state.retryAttempts);
    state.retryAttempts += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      subscribeEntry(state);
    }, delay);
  };
  function handleEntryError(state, error) {
    state.errorCount += 1;
    getDbLogger().error(LOG_PREFIX, 'subscription error', {
      key: state.entry.key,
      error
    });
    unsubscribeEntry(state);
    scheduleRetry(state);
  }
  const deactivateAll = () => {
    for (const state of states) {
      clearRetryTimer(state);
      clearDebounceBuckets(state);
      unsubscribeEntry(state);
    }
  };
  return {
    setActive(nextActive) {
      if (nextActive === active) return;
      if (!nextActive) {
        active = false;
        deactivateAll();
        return;
      }
      const subscribe = getDbTransport().subscribe;
      if (!subscribe) {
        throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
      }
      active = true;
      for (const state of states) {
        subscribeEntry(state);
      }
    },
    isActive() {
      return active;
    },
    dispatch(key, payload) {
      const state = byKey.get(key);
      if (!state) {
        getDbLogger().debug(LOG_PREFIX, 'dispatch skipped', {
          key
        });
        return;
      }
      handlePayload(state, payload);
    },
    inspect() {
      return states.map(state => ({
        key: state.entry.key,
        active: Boolean(state.unsubscribe),
        eventCount: state.eventCount,
        lastEventAt: state.lastEventAt,
        errorCount: state.errorCount
      }));
    },
    stop() {
      active = false;
      deactivateAll();
    }
  };
};
//# sourceMappingURL=subscriptionRuntime.js.map