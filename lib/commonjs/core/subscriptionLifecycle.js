"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelEventLifecycle = void 0;
var _retryPolicy = require("./fetch/retryPolicy.js");
var _syncError = require("./syncError.js");
var _networkState = require("./fetch/networkState.js");
var _logger = require("./logger.js");
var _transport = require("./transport.js");
var _reset = require("./reset.js");
var _pacer = require("@tanstack/pacer");
var _runtimeGeneration = require("../utils/runtimeGeneration.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
const LOG_PREFIX = 'ModelEventLifecycle';
const GLOBAL_DEBOUNCE_KEY = '__global__';

/** Create the activation, delivery, debounce, retry, and reset lifecycle for static subscription entries. */
const createModelEventLifecycle = entries => {
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
    byKey: new Map(states.map(state => [state.entry.key, state])),
    active: false,
    activationEpoch: 0,
    generationFence: (0, _runtimeGeneration.createGenerationFence)({
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
    if (!(0, _normalizeHelpers.isNonArrayRecord)(payload)) {
      (0, _logger.getDbLogger)().debug(LOG_PREFIX, 'payload skipped', {
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
      bucket = new _pacer.Debouncer(latestPayload => {
        state.debounceBuckets.delete(bucketKey);
        state.debouncePayloads.delete(bucketKey);
        // Timer context: a throw here has no caller to reach - contain and report instead.
        try {
          runHandler(state, latestPayload);
        } catch (error) {
          state.errorCount += 1;
          (0, _syncError.reportSyncError)(error, {
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
    if (!(0, _normalizeHelpers.isNonArrayRecord)(data)) {
      (0, _logger.getDbLogger)().debug(LOG_PREFIX, 'response skipped', {
        key: state.entry.key
      });
      return;
    }
    handlePayload(state, data[state.entry.payloadKey ?? state.entry.key]);
  };
  const subscribeEntry = state => {
    if (!context.active || !isCurrentGeneration() || state.unsubscribe) return;
    clearRetryWait(state);
    const subscribe = (0, _transport.getDbTransport)().subscribe;
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
    if (!(0, _networkState.isFetchNetworkOnline)()) {
      const release = (0, _networkState.subscribeFetchNetwork)(() => {
        if (state.retryNetworkRelease === release) state.retryNetworkRelease = null;
        release();
        if (!(0, _networkState.isFetchNetworkOnline)()) return;
        subscribeEntry(state);
      });
      state.retryNetworkRelease = release;
      return;
    }
    const delay = (0, _retryPolicy.backoffDelayMs)(state.retryAttempts);
    state.retryAttempts += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      subscribeEntry(state);
    }, delay);
  };
  function handleEntryError(state, error, epoch, token) {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    state.errorCount += 1;
    (0, _logger.getDbLogger)().error(LOG_PREFIX, 'subscription error', {
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
  const unregisterReset = (0, _reset.registerReset)(() => {
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
      if (!(0, _transport.getDbTransport)().subscribe) throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
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
    dispatch(key, payload) {
      const state = context.byKey.get(key);
      if (!state) {
        (0, _logger.getDbLogger)().debug(LOG_PREFIX, 'dispatch skipped', {
          key
        });
        return;
      }
      handlePayload(state, payload);
    },
    inspect,
    stop() {
      reset();
      unregisterReset();
    }
  };
};
exports.createModelEventLifecycle = createModelEventLifecycle;
//# sourceMappingURL=subscriptionLifecycle.js.map