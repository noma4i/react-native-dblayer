"use strict";

import { backoffDelayMs } from "./fetch/retryPolicy.js";
import { noteDataLoss } from "./diagnostics.js";
import { reportSyncError } from "./syncError.js";
import { isFetchNetworkOnline, subscribeFetchNetwork } from "./fetch/networkState.js";
import { getDbLogger } from "./logger.js";
import { getDbTransport } from "./transport.js";
import { registerReset } from "./reset.js";
import { Debouncer } from '@tanstack/pacer';
import { createGenerationFence } from "../utils/runtimeGeneration.js";
import { isNonArrayRecord } from "../utils/normalizeHelpers.js";
const LOG_PREFIX = 'ModelEventLifecycle';
const GLOBAL_DEBOUNCE_KEY = '__global__';

/** Create the activation, delivery, debounce, retry, and reset lifecycle for static subscription entries. */
export const createModelEventLifecycle = entries => {
  const runtimeEntries = entries;
  const registeredKeys = new Set();
  for (const entry of runtimeEntries) {
    if (registeredKeys.has(entry.key)) throw new Error(`Subscription entry already registered for key ${entry.key}`);
    registeredKeys.add(entry.key);
  }
  const states = runtimeEntries.map(entry => ({
    entry,
    unsubscribe: null,
    debounceBuckets: new Map(),
    debouncePayloads: new Map(),
    retryTimer: null,
    retryNetworkRelease: null,
    retryAttempts: 0,
    eventCount: 0,
    lastEventAt: null,
    errorCount: 0,
    attemptToken: 0
  }));
  const context = {
    states,
    active: false,
    activationEpoch: 0,
    generationFence: createGenerationFence({
      lazy: true
    })
  };
  const isCurrentGeneration = () => context.generationFence.isCurrent();
  const clearDebounceBuckets = state => {
    state.debounceBuckets.forEach(bucket => bucket.cancel());
    state.debounceBuckets.clear();
    state.debouncePayloads.clear();
  };
  const clearRetryWait = state => {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.retryNetworkRelease) {
      state.retryNetworkRelease();
      state.retryNetworkRelease = null;
    }
  };
  const unsubscribeEntry = state => {
    const unsubscribe = state.unsubscribe;
    state.unsubscribe = null;
    if (unsubscribe) unsubscribe();
  };
  /** Counts a delivery only after `onData` completes without throwing. */
  const runHandler = (state, payload) => {
    if (!isCurrentGeneration()) return;
    state.entry.onData(payload);
    state.eventCount += 1;
  };
  const handlePayload = (state, payload) => {
    if (!isNonArrayRecord(payload)) {
      noteDataLoss('subscription-payload-mismatch', state.entry.key, 1);
      getDbLogger().debug(LOG_PREFIX, 'payload skipped', {
        key: state.entry.key
      });
      return;
    }
    state.retryAttempts = 0;
    state.lastEventAt = Date.now();
    const debounce = state.entry.debounce;
    if (!debounce) {
      runHandler(state, payload);
      return;
    }
    const bucketKey = debounce.keyOf?.(payload) ?? GLOBAL_DEBOUNCE_KEY;
    const previousPayload = state.debouncePayloads.get(bucketKey);
    const nextPayload = previousPayload === undefined || debounce.merge === undefined ? payload : debounce.merge(previousPayload, payload);
    state.debouncePayloads.set(bucketKey, nextPayload);
    let bucket = state.debounceBuckets.get(bucketKey);
    if (!bucket) {
      bucket = new Debouncer(latestPayload => {
        state.debounceBuckets.delete(bucketKey);
        state.debouncePayloads.delete(bucketKey);
        // Timer context: a throw here has no caller to reach - contain and report instead.
        try {
          runHandler(state, latestPayload);
        } catch (error) {
          state.errorCount += 1;
          reportSyncError(error, {
            source: 'subscription',
            key: state.entry.key
          }, LOG_PREFIX);
        }
      }, {
        wait: debounce.ms
      });
      state.debounceBuckets.set(bucketKey, bucket);
    }
    bucket.maybeExecute(nextPayload);
  };
  const isCurrentAttempt = (state, epoch, token) => context.active && isCurrentGeneration() && epoch === context.activationEpoch && state.attemptToken === token;
  const handleTransportNext = (state, data, epoch, token) => {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    if (!isNonArrayRecord(data)) {
      noteDataLoss('subscription-payload-mismatch', state.entry.key, 1);
      getDbLogger().debug(LOG_PREFIX, 'response skipped', {
        key: state.entry.key
      });
      return;
    }
    handlePayload(state, data[state.entry.payloadKey ?? state.entry.key]);
  };
  const subscribeEntry = state => {
    if (!context.active || !isCurrentGeneration() || state.unsubscribe) return;
    clearRetryWait(state);
    const subscribe = getDbTransport().subscribe;
    const epoch = context.activationEpoch;
    const token = state.attemptToken + 1;
    const placeholder = () => {};
    state.attemptToken = token;
    state.unsubscribe = placeholder;
    let unsubscribe;
    try {
      unsubscribe = subscribe({
        query: state.entry.query,
        variables: state.entry.vars
      }, {
        next: data => handleTransportNext(state, data, epoch, token),
        error: error => handleEntryError(state, error, epoch, token)
      });
    } catch (error) {
      if (isCurrentAttempt(state, epoch, token) && state.unsubscribe === placeholder) state.unsubscribe = null;
      throw error;
    }
    if (!isCurrentAttempt(state, epoch, token) || state.unsubscribe !== placeholder) {
      unsubscribe();
      return;
    }
    state.unsubscribe = unsubscribe;
    try {
      state.entry.onSubscribe?.();
    } catch (error) {
      handleEntryError(state, error, epoch, token);
    }
  };
  const scheduleRetry = state => {
    clearRetryWait(state);
    /** Offline gate: never burn retry attempts without a network - resubscribe once connectivity returns. */
    if (!isFetchNetworkOnline()) {
      const release = subscribeFetchNetwork(() => {
        if (state.retryNetworkRelease === release) state.retryNetworkRelease = null;
        release();
        if (!isFetchNetworkOnline()) return;
        subscribeEntry(state);
      });
      state.retryNetworkRelease = release;
      return;
    }
    const delay = backoffDelayMs(state.retryAttempts);
    state.retryAttempts += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      subscribeEntry(state);
    }, delay);
  };
  function handleEntryError(state, error, epoch, token) {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    state.errorCount += 1;
    getDbLogger().error(LOG_PREFIX, 'subscription error', {
      key: state.entry.key,
      error
    });
    unsubscribeEntry(state);
    scheduleRetry(state);
  }
  const deactivateAll = () => {
    for (const state of context.states) {
      clearRetryWait(state);
      clearDebounceBuckets(state);
      unsubscribeEntry(state);
    }
  };
  const reset = () => {
    context.active = false;
    context.activationEpoch += 1;
    deactivateAll();
  };
  // Registry-driven reset only clears PAST-generation state: a runtime created inside the current
  // resetRuntime pass (generation already advanced) must survive that same pass, otherwise a reset
  // callback that re-creates its runtime gets the fresh subscription killed by this very iteration.
  // stop() below stays unconditional - an explicit caller teardown is not generation-scoped.
  const unregisterReset = registerReset(() => {
    if (isCurrentGeneration()) return;
    reset();
  });
  const inspect = () => context.states.map(state => ({
    key: state.entry.key,
    active: Boolean(state.unsubscribe),
    eventCount: state.eventCount,
    lastEventAt: state.lastEventAt,
    errorCount: state.errorCount
  }));
  return {
    setActive(nextActive) {
      const staleWhileActive = context.active && nextActive && !isCurrentGeneration();
      if (nextActive === context.active && !staleWhileActive) return;
      if (!nextActive) {
        context.active = false;
        deactivateAll();
        return;
      }
      if (staleWhileActive) deactivateAll();
      if (!getDbTransport().subscribe) throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
      context.active = true;
      context.activationEpoch += 1;
      context.generationFence.captureNow();
      try {
        for (const state of context.states) subscribeEntry(state);
      } catch (error) {
        context.active = false;
        context.activationEpoch += 1;
        deactivateAll();
        throw error;
      }
    },
    isActive: () => context.active,
    inspect,
    stop() {
      reset();
      unregisterReset();
    }
  };
};
//# sourceMappingURL=subscriptionLifecycle.js.map