"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.resetSubscriptionRuntimeEffects = exports.getDbSubscriptionEffect = exports.defineDbSubscriptionEntry = exports.createDbSubscriptionRuntime = exports.createDbSubscriptionEffects = void 0;
var _logger = require("./logger.js");
var _transport = require("./transport.js");
var _normalizeHelpers = require("../utils/normalizeHelpers.js");
var _runtimePrimitives = require("../utils/runtimePrimitives.js");
var _reset = require("./reset.js");
const LOG_PREFIX = 'DbSubscriptionRuntime';
const GLOBAL_DEBOUNCE_KEY = '__global__';
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const namedEffects = new Map();

/** Clear injected effect wrappers during runtime teardown. */
const resetSubscriptionRuntimeEffects = () => {
  namedEffects.clear();
};
exports.resetSubscriptionRuntimeEffects = resetSubscriptionRuntimeEffects;
(0, _reset.registerReset)(resetSubscriptionRuntimeEffects);

/** Resolve an injected subscription effect by its stable application name. */
const getDbSubscriptionEffect = name => namedEffects.get(name);

/**
 * Static subscription registration consumed by `createDbSubscriptionRuntime`.
 *
 * @template TPayload Payload object under `responseData[key]`.
 */
exports.getDbSubscriptionEffect = getDbSubscriptionEffect;
/**
 * Define a subscription entry whose key, variables, payload handler, and debounce key resolver are
 * inferred from a typed GraphQL document. The returned entry is erased only at the runtime registry
 * boundary so heterogeneous subscription documents can share one array without losing authoring checks.
 *
 * @param entry Typed subscription document, root-field key, variables, debounce, and payload handler.
 * @returns Runtime subscription entry accepted by `createDbSubscriptionRuntime`.
 */
const defineDbSubscriptionEntry = entry => entry;

/** Function table of UI effects invoked by subscription entries. */

/** Effects channel returned by `createDbSubscriptionEffects`. */
exports.defineDbSubscriptionEntry = defineDbSubscriptionEntry;
/**
 * Create an injectable effects channel for subscription entries.
 *
 * Entries call `channel.effects.onX(...)` where a UI reaction is needed; the app injects real
 * implementations with `configure` when its effect owner mounts and calls `reset` on teardown.
 *
 * @param noopEffects Complete effect table with no-op implementations; defines the channel's keys.
 * @returns Stable `effects` table plus `configure`/`reset` controls.
 */
const createDbSubscriptionEffects = noopEffects => {
  let activeEffects = noopEffects;
  const effects = Object.fromEntries(Object.keys(noopEffects).map(key => [key, (...args) => {
    activeEffects[key](...args);
  }]));
  namedEffects.clear();
  for (const [name, effect] of Object.entries(effects)) namedEffects.set(name, effect);
  return {
    effects,
    configure: overrides => {
      activeEffects = {
        ...noopEffects,
        ...overrides
      };
    },
    reset: () => {
      activeEffects = noopEffects;
    }
  };
};

/** Runtime inspection row for a registered subscription entry. */

/** Runtime controller returned by `createDbSubscriptionRuntime`. */
exports.createDbSubscriptionEffects = createDbSubscriptionEffects;
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
const createDbSubscriptionRuntime = entries => {
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
  let activationEpoch = 0;
  const generationFence = (0, _runtimePrimitives.createGenerationFence)({
    lazy: true
  });
  const isCurrentGeneration = () => generationFence.isCurrent();
  const runHandler = (state, payload) => {
    if (!isCurrentGeneration()) return;
    state.entry.onData(payload);
  };
  const handlePayload = (state, payload) => {
    if (!isCurrentGeneration()) return;
    if (!(0, _normalizeHelpers.isNonArrayRecord)(payload)) {
      (0, _logger.getDbLogger)().debug(LOG_PREFIX, 'payload skipped', {
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
  const handleTransportNext = (state, data, epoch) => {
    if (!active || epoch !== activationEpoch) return;
    if (!(0, _normalizeHelpers.isNonArrayRecord)(data)) {
      (0, _logger.getDbLogger)().debug(LOG_PREFIX, 'response skipped', {
        key: state.entry.key
      });
      return;
    }
    handlePayload(state, data[state.entry.key]);
  };
  const subscribeEntry = state => {
    if (!active || !isCurrentGeneration() || state.unsubscribe) return;
    clearRetryTimer(state);
    const subscribe = (0, _transport.getDbTransport)().subscribe;
    if (!subscribe) {
      throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
    }
    const epoch = activationEpoch;
    state.unsubscribe = subscribe({
      query: state.entry.query,
      variables: state.entry.vars
    }, {
      next: data => handleTransportNext(state, data, epoch),
      error: error => {
        if (epoch === activationEpoch) handleEntryError(state, error);
      }
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
    (0, _logger.getDbLogger)().error(LOG_PREFIX, 'subscription error', {
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
  const reset = () => {
    active = false;
    activationEpoch += 1;
    deactivateAll();
  };
  const unregisterReset = (0, _reset.registerReset)(reset);
  return {
    setActive(nextActive) {
      if (nextActive === active) return;
      if (!nextActive) {
        active = false;
        deactivateAll();
        return;
      }
      const subscribe = (0, _transport.getDbTransport)().subscribe;
      if (!subscribe) {
        throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
      }
      active = true;
      activationEpoch += 1;
      generationFence.captureNow();
      for (const state of states) {
        subscribeEntry(state);
      }
    },
    isActive() {
      return active;
    },
    dispatch(key, payload) {
      if (!isCurrentGeneration()) return;
      const state = byKey.get(key);
      if (!state) {
        (0, _logger.getDbLogger)().debug(LOG_PREFIX, 'dispatch skipped', {
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
      reset();
      unregisterReset();
    }
  };
};
exports.createDbSubscriptionRuntime = createDbSubscriptionRuntime;
//# sourceMappingURL=subscriptionRuntime.js.map