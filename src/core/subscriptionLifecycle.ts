import { getDbLogger } from './logger';
import { getDbTransport } from './transport';
import { registerReset } from './reset';
import { Debouncer } from '@tanstack/pacer';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { isNonArrayRecord } from '../utils/normalizeHelpers';
import type { DbSubscriptionEntry, DbSubscriptionRuntime, DbSubscriptionRuntimeInspectRow } from '../types';

const LOG_PREFIX = 'DbSubscriptionRuntime';
const GLOBAL_DEBOUNCE_KEY = '__global__';
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

type SubscriptionEntryState = {
  entry: DbSubscriptionEntry;
  unsubscribe: (() => void) | null;
  debounceBuckets: Map<string, Debouncer<(payload: unknown) => void>>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempts: number;
  eventCount: number;
  lastEventAt: number | null;
  errorCount: number;
  attemptToken: number;
};

type SubscriptionLifecycleContext = {
  states: SubscriptionEntryState[];
  byKey: Map<string, SubscriptionEntryState>;
  active: boolean;
  activationEpoch: number;
  generationFence: ReturnType<typeof createGenerationFence>;
};

const nextRetryDelay = (attempts: number): number => Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempts), MAX_RETRY_DELAY_MS);

/** Create the activation, delivery, debounce, retry, and reset lifecycle for static subscription entries. */
export const createSubscriptionLifecycle = <TPayload = unknown>(entries: readonly DbSubscriptionEntry<TPayload>[]): DbSubscriptionRuntime => {
  const runtimeEntries = entries as readonly DbSubscriptionEntry[];
  const registeredKeys = new Set<string>();
  for (const entry of runtimeEntries) {
    if (registeredKeys.has(entry.key)) throw new Error(`Subscription entry already registered for key ${entry.key}`);
    registeredKeys.add(entry.key);
  }
  const states = runtimeEntries.map(entry => ({
    entry,
    unsubscribe: null,
    debounceBuckets: new Map<string, Debouncer<(payload: unknown) => void>>(),
    retryTimer: null,
    retryAttempts: 0,
    eventCount: 0,
    lastEventAt: null,
    errorCount: 0,
    attemptToken: 0
  }));
  const context: SubscriptionLifecycleContext = {
    states,
    byKey: new Map(states.map(state => [state.entry.key, state])),
    active: false,
    activationEpoch: 0,
    generationFence: createGenerationFence({ lazy: true })
  };
  const isCurrentGeneration = (): boolean => context.generationFence.isCurrent();

  const clearDebounceBuckets = (state: SubscriptionEntryState): void => {
    state.debounceBuckets.forEach(bucket => bucket.cancel());
    state.debounceBuckets.clear();
  };
  const clearRetryTimer = (state: SubscriptionEntryState): void => {
    if (!state.retryTimer) return;
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  };
  const unsubscribeEntry = (state: SubscriptionEntryState): void => {
    const unsubscribe = state.unsubscribe;
    state.unsubscribe = null;
    if (unsubscribe) unsubscribe();
  };
  /** Counts a delivery only after `onData` completes without throwing. */
  const runHandler = (state: SubscriptionEntryState, payload: unknown): void => {
    if (!isCurrentGeneration()) return;
    state.entry.onData(payload);
    state.eventCount += 1;
  };
  const handlePayload = (state: SubscriptionEntryState, payload: unknown): void => {
    if (!isCurrentGeneration()) return;
    if (!isNonArrayRecord(payload)) {
      getDbLogger().debug(LOG_PREFIX, 'payload skipped', { key: state.entry.key });
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
    let bucket = state.debounceBuckets.get(bucketKey);
    if (!bucket) {
      bucket = new Debouncer(latestPayload => {
        state.debounceBuckets.delete(bucketKey);
        runHandler(state, latestPayload);
      }, { wait: debounce.ms });
      state.debounceBuckets.set(bucketKey, bucket);
    }
    bucket.maybeExecute(payload);
  };
  const isCurrentAttempt = (state: SubscriptionEntryState, epoch: number, token: number): boolean =>
    context.active && isCurrentGeneration() && epoch === context.activationEpoch && state.attemptToken === token;
  const handleTransportNext = (state: SubscriptionEntryState, data: unknown, epoch: number, token: number): void => {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    if (!isNonArrayRecord(data)) {
      getDbLogger().debug(LOG_PREFIX, 'response skipped', { key: state.entry.key });
      return;
    }
    handlePayload(state, data[state.entry.key]);
  };
  const subscribeEntry = (state: SubscriptionEntryState): void => {
    if (!context.active || !isCurrentGeneration() || state.unsubscribe) return;
    clearRetryTimer(state);
    const subscribe = getDbTransport().subscribe;
    if (!subscribe) throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
    const epoch = context.activationEpoch;
    const token = state.attemptToken + 1;
    const placeholder = (): void => {};
    state.attemptToken = token;
    state.unsubscribe = placeholder;
    let unsubscribe: () => void;
    try {
      unsubscribe = subscribe(
        { query: state.entry.query, variables: state.entry.vars },
        { next: data => handleTransportNext(state, data, epoch, token), error: error => handleEntryError(state, error, epoch, token) }
      );
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
  const scheduleRetry = (state: SubscriptionEntryState, epoch: number, token: number): void => {
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
  function handleEntryError(state: SubscriptionEntryState, error: unknown, epoch: number, token: number): void {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    state.errorCount += 1;
    getDbLogger().error(LOG_PREFIX, 'subscription error', { key: state.entry.key, error });
    unsubscribeEntry(state);
    scheduleRetry(state, epoch, token);
  }
  const deactivateAll = (): void => {
    for (const state of context.states) {
      clearRetryTimer(state);
      clearDebounceBuckets(state);
      unsubscribeEntry(state);
    }
  };
  const reset = (): void => {
    context.active = false;
    context.activationEpoch += 1;
    deactivateAll();
  };
  const unregisterReset = registerReset(reset);
  const inspect = (): DbSubscriptionRuntimeInspectRow[] => context.states.map(state => ({
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
    dispatch(key, payload) {
      if (!isCurrentGeneration()) return;
      const state = context.byKey.get(key);
      if (!state) {
        getDbLogger().debug(LOG_PREFIX, 'dispatch skipped', { key });
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
