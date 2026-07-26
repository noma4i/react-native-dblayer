"use strict";

import { getDbLogger } from "./logger.js";
import { getDbTransport } from "./transport.js";
import { isNonArrayRecord } from "../utils/normalizeHelpers.js";
import { createGenerationFence } from "../utils/runtimePrimitives.js";
import { registerReset } from "./reset.js";
const LOG_PREFIX = 'DbSubscriptionRuntime';
const GLOBAL_DEBOUNCE_KEY = '__global__';
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const namedEffects = new Map();

/** Clear injected effect wrappers during runtime teardown. */
const resetSubscriptionRuntimeEffects = () => {
  namedEffects.clear();
};
registerReset(resetSubscriptionRuntimeEffects);

/** Resolve an injected subscription effect by its stable application name. */
export const getDbSubscriptionEffect = name => namedEffects.get(name);

/**
 * Static subscription registration consumed by `createDbSubscriptionRuntime`.
 *
 * @template TPayload Payload object under `responseData[key]`.
 */

/**
 * Define a subscription entry whose key, variables, payload handler, and debounce key resolver are
 * inferred from a typed GraphQL document. The returned entry is erased only at the runtime registry
 * boundary so heterogeneous subscription documents can share one array without losing authoring checks.
 *
 * @param entry Typed subscription document, root-field key, variables, debounce, and payload handler.
 * @returns Runtime subscription entry accepted by `createDbSubscriptionRuntime`.
 */
export const defineDbSubscriptionEntry = entry => {
  /** Typed-document variance is intentionally erased at the heterogeneous runtime registry boundary. */
  return entry;
};

/** Effects channel returned by `createDbSubscriptionEffects`. */

/**
 * Create an injectable effects channel for subscription entries.
 *
 * Entries call `channel.effects.onX(...)` where a UI reaction is needed; the app injects real
 * implementations with `configure` when its effect owner mounts and calls `reset` on teardown.
 *
 * @param noopEffects Complete effect table with no-op implementations; defines the channel's keys.
 * @returns Stable `effects` table plus `configure`/`reset` controls.
 */
export const createDbSubscriptionEffects = noopEffects => {
  let activeEffects = noopEffects;
  const names = Object.keys(noopEffects);
  for (const name of names) {
    if (namedEffects.has(name)) throw new Error(`subscription effect already registered: ${name}`);
  }

  /** Object.fromEntries cannot preserve the keyed function correlation represented by TEffects. */
  const effects = Object.fromEntries(names.map(key => [key, (...args) => {
    /** Dynamic key iteration loses each effect's parameter tuple before invocation. */
    activeEffects[key](...args);
  }]));
  for (const [name, effect] of Object.entries(effects)) namedEffects.set(name, effect);
  const unregisterNames = () => {
    for (const name of names) {
      const effect = effects[name];
      if (namedEffects.get(name) === effect) namedEffects.delete(name);
    }
  };
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
      unregisterNames();
    }
  };
};

/** Runtime inspection row for a registered subscription entry. */

/** Runtime controller returned by `createDbSubscriptionRuntime`. */

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
  /** Runtime validation narrows every dispatched payload before the heterogeneous state table invokes it. */
  const runtimeEntries = entries;
  const states = runtimeEntries.map(entry => ({
    entry,
    unsubscribe: null,
    debounceBuckets: new Map(),
    retryTimer: null,
    retryAttempts: 0,
    eventCount: 0,
    lastEventAt: null,
    errorCount: 0,
    attemptToken: 0
  }));
  const byKey = new Map(states.map(state => [state.entry.key, state]));
  let active = false;
  let activationEpoch = 0;
  const generationFence = createGenerationFence({
    lazy: true
  });
  const isCurrentGeneration = () => generationFence.isCurrent();

  /** Counts a delivery only once `onData` has returned without throwing - a throw must not inflate the delivered-event metric. */
  const runHandler = (state, payload) => {
    if (!isCurrentGeneration()) return;
    state.entry.onData(payload);
    state.eventCount += 1;
  };
  const handlePayload = (state, payload) => {
    if (!isCurrentGeneration()) return;
    if (!isNonArrayRecord(payload)) {
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
  const isCurrentAttempt = (state, epoch, token) => active && isCurrentGeneration() && epoch === activationEpoch && state.attemptToken === token;
  const handleTransportNext = (state, data, epoch, token) => {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    if (!isNonArrayRecord(data)) {
      getDbLogger().debug(LOG_PREFIX, 'response skipped', {
        key: state.entry.key
      });
      return;
    }
    handlePayload(state, data[state.entry.key]);
  };
  const subscribeEntry = state => {
    if (!active || !isCurrentGeneration() || state.unsubscribe) return;
    clearRetryTimer(state);
    const subscribe = getDbTransport().subscribe;
    if (!subscribe) {
      throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
    }
    const epoch = activationEpoch;
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
  };
  const scheduleRetry = (state, epoch, token) => {
    if (!isCurrentAttempt(state, epoch, token)) return;
    clearRetryTimer(state);
    const delay = nextRetryDelay(state.retryAttempts);
    state.retryAttempts += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!isCurrentAttempt(state, epoch, token) || state.unsubscribe) return;
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
    scheduleRetry(state, epoch, token);
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
  const unregisterReset = registerReset(reset);
  return {
    setActive(nextActive) {
      /** A `configureDb` re-configuration bumps the runtime generation without deactivating this runtime; without this check a same-value `setActive(true)` no-ops forever and every subsequent event is silently dropped by the stale generation fence. */
      const staleWhileActive = active && nextActive && !isCurrentGeneration();
      if (nextActive === active && !staleWhileActive) return;
      if (!nextActive) {
        active = false;
        deactivateAll();
        return;
      }
      if (staleWhileActive) deactivateAll();
      const subscribe = getDbTransport().subscribe;
      if (!subscribe) {
        throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
      }
      active = true;
      activationEpoch += 1;
      generationFence.captureNow();
      try {
        for (const state of states) {
          subscribeEntry(state);
        }
      } catch (error) {
        active = false;
        activationEpoch += 1;
        deactivateAll();
        throw error;
      }
    },
    isActive() {
      return active;
    },
    dispatch(key, payload) {
      if (!isCurrentGeneration()) return;
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
      reset();
      unregisterReset();
    }
  };
};
//# sourceMappingURL=subscriptionRuntime.js.map