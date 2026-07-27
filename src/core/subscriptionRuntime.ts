import type { ResultOf, TypedDocumentNode, VariablesOf } from '@graphql-typed-document-node/core';
import { getDbLogger } from './logger';
import { getDbTransport } from './transport';
import type { DbGraphQLDocument } from '../types';
import { isNonArrayRecord } from '../utils/normalizeHelpers';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { getRuntimeGeneration } from '../dsl/configure';
import { registerReset } from './reset';

const LOG_PREFIX = 'DbSubscriptionRuntime';
const GLOBAL_DEBOUNCE_KEY = '__global__';
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const namedEffects = new Map<string, (...args: unknown[]) => void>();
const namedEffectGenerations = new Map<string, number>();

/** Clear injected effect wrappers during runtime teardown. */
const resetSubscriptionRuntimeEffects = (): void => {
  namedEffects.clear();
  namedEffectGenerations.clear();
};

registerReset(resetSubscriptionRuntimeEffects);

/** Resolve an injected subscription effect by its stable application name. */
export const getDbSubscriptionEffect = (name: string): ((...args: unknown[]) => void) | undefined => namedEffects.get(name);

/**
 * Static subscription registration consumed by `createDbSubscriptionRuntime`.
 *
 * @template TPayload Payload object under `responseData[key]`.
 */
export type DbSubscriptionEntry<TPayload = unknown> = {
  /** Payload key under response data and stable registry id. */
  key: string;
  /** GraphQL subscription document passed to the configured transport. */
  query: DbGraphQLDocument;
  /** Static GraphQL variables passed unchanged to the transport. */
  vars?: Record<string, unknown>;
  /** Optional trailing debounce. Omit `keyOf` to use one global bucket for the entry. */
  debounce?: {
    /** Trailing debounce delay in milliseconds. */
    ms: number;
    /** Optional bucket key resolver; latest payload wins within each bucket. */
    keyOf?: (payload: TPayload) => string;
  };
  /** Handler invoked with a validated payload after debounce, if configured. */
  onData: (payload: TPayload) => void;
};

type TypedDbSubscriptionEntry<TDocument extends TypedDocumentNode<unknown, never>, TKey extends Extract<keyof ResultOf<TDocument>, string>> = Omit<
  DbSubscriptionEntry<ResultOf<TDocument>[TKey]>,
  'key' | 'query' | 'vars'
> & {
  key: TKey;
  query: TDocument;
  vars?: VariablesOf<TDocument>;
};

/**
 * Define a subscription entry whose key, variables, payload handler, and debounce key resolver are
 * inferred from a typed GraphQL document. The returned entry is erased only at the runtime registry
 * boundary so heterogeneous subscription documents can share one array without losing authoring checks.
 *
 * @param entry Typed subscription document, root-field key, variables, debounce, and payload handler.
 * @returns Runtime subscription entry accepted by `createDbSubscriptionRuntime`.
 */
export const defineDbSubscriptionEntry = <TDocument extends TypedDocumentNode<unknown, never>, TKey extends Extract<keyof ResultOf<TDocument>, string>>(
  entry: TypedDbSubscriptionEntry<TDocument, TKey>
): DbSubscriptionEntry => {
  /** Typed-document variance is intentionally erased at the heterogeneous runtime registry boundary. */
  return entry as unknown as DbSubscriptionEntry;
};

/** Effects channel returned by `createDbSubscriptionEffects`. */
export type DbSubscriptionEffectsChannel<TEffects extends Record<keyof TEffects, (...args: never[]) => void>> = {
  /**
   * Stable wrapper table with the same keys as the noop table. Each wrapper forwards to the currently
   * configured effect. The table and every wrapper keep one identity for the channel's lifetime, so
   * subscription entries can capture them at build time and never rebind.
   */
  effects: TEffects;
  /** Replace active effects; keys omitted from `overrides` fall back to the noop implementation. */
  configure: (overrides: Partial<TEffects>) => void;
  /** Restore every effect to its noop implementation and unregister this channel's named effects. */
  reset: () => void;
};

/**
 * Create an injectable effects channel for subscription entries.
 *
 * Entries call `channel.effects.onX(...)` where a UI reaction is needed; the app injects real
 * implementations with `configure` when its effect owner mounts and calls `reset` on teardown.
 *
 * A duplicate effect name within one runtime generation throws; a later generation deliberately
 * replaces the stale wrapper so recreated runtimes can reuse stable effect names. This is the same
 * generation rule the apply-target, relation, GC, ingest, invalidation, and maintenance registries follow.
 *
 * @param noopEffects Complete effect table with no-op implementations; defines the channel's keys.
 * @returns Stable `effects` table plus `configure`/`reset` controls.
 */
export const createDbSubscriptionEffects = <TEffects extends Record<keyof TEffects, (...args: never[]) => void>>(noopEffects: TEffects): DbSubscriptionEffectsChannel<TEffects> => {
  let activeEffects: TEffects = noopEffects;
  const names = Object.keys(noopEffects);
  const generation = getRuntimeGeneration();
  for (const name of names) {
    if (namedEffects.has(name) && namedEffectGenerations.get(name) === generation) throw new Error(`subscription effect already registered: ${name}`);
  }

  /** Object.fromEntries cannot preserve the keyed function correlation represented by TEffects. */
  const effects = Object.fromEntries(
    names.map(key => [
      key,
      (...args: unknown[]) => {
        /** Dynamic key iteration loses each effect's parameter tuple before invocation. */
        (activeEffects[key as keyof TEffects] as unknown as (...forwarded: unknown[]) => void)(...args);
      }
    ])
  ) as unknown as TEffects;
  for (const [name, effect] of Object.entries(effects)) {
    namedEffects.set(name, effect as (...args: unknown[]) => void);
    namedEffectGenerations.set(name, generation);
  }
  const unregisterNames = (): void => {
    for (const name of names) {
      const effect = effects[name as keyof TEffects] as unknown as (...args: unknown[]) => void;
      if (namedEffects.get(name) !== effect) continue;
      namedEffects.delete(name);
      namedEffectGenerations.delete(name);
    }
  };

  return {
    effects,
    configure: overrides => {
      activeEffects = { ...noopEffects, ...overrides } as TEffects;
    },
    reset: () => {
      activeEffects = noopEffects;
      unregisterNames();
    }
  };
};

/** Runtime inspection row for a registered subscription entry. */
export type DbSubscriptionRuntimeInspectRow = {
  /** Registry key for the subscription entry. */
  key: string;
  /** Whether this entry currently has an active transport subscription. */
  active: boolean;
  /** Count of validated events accepted by the runtime pipeline. */
  eventCount: number;
  /** Last validated event timestamp from `Date.now()`, or null before the first event. */
  lastEventAt: number | null;
  /** Count of transport errors observed for this entry. */
  errorCount: number;
};

/** Runtime controller returned by `createDbSubscriptionRuntime`. */
export type DbSubscriptionRuntime = {
  /**
   * Activate or deactivate all registered transport subscriptions.
   *
   * First activation requires `configureDb({ transport })` with `transport.subscribe`. Reconnect and
   * observer resubscription inside the transport remain transparent to this runtime. If one entry throws
   * while starting, every entry started by that activation is unsubscribed, the runtime remains inactive,
   * and the original error is rethrown.
   *
   * @param active True subscribes all entries; false unsubscribes all entries and clears pending timers.
   * @returns void
   */
  setActive(active: boolean): void;
  /**
   * Read the runtime-wide active flag.
   *
   * @returns True after `setActive(true)` until `setActive(false)` or `stop()`.
   */
  isActive(): boolean;
  /**
   * Manually inject a payload into the same validate, debounce, and handler pipeline used by transport events.
   *
   * @param key Registry key for the target entry.
   * @param payload Payload object to validate and dispatch.
   * @returns void
   */
  dispatch(key: string, payload: unknown): void;
  /**
   * Inspect runtime counters for every registered entry.
   *
   * @returns Snapshot rows in registration order.
   */
  inspect(): DbSubscriptionRuntimeInspectRow[];
  /**
   * Final teardown for transport subscriptions and pending debounce/retry timers.
   *
   * @returns void
   */
  stop(): void;
};

type RuntimeEntry = DbSubscriptionEntry;

type DebounceBucket = {
  timer: ReturnType<typeof setTimeout>;
  payload: unknown;
};

type EntryState = {
  entry: RuntimeEntry;
  unsubscribe: (() => void) | null;
  debounceBuckets: Map<string, DebounceBucket>;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempts: number;
  eventCount: number;
  lastEventAt: number | null;
  errorCount: number;
  attemptToken: number;
};

const nextRetryDelay = (attempts: number): number => Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempts), MAX_RETRY_DELAY_MS);

const clearDebounceBuckets = (state: EntryState): void => {
  state.debounceBuckets.forEach(bucket => clearTimeout(bucket.timer));
  state.debounceBuckets.clear();
};

const clearRetryTimer = (state: EntryState): void => {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
};

const unsubscribeEntry = (state: EntryState): void => {
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
export const createDbSubscriptionRuntime = <TPayload = unknown>(entries: readonly DbSubscriptionEntry<TPayload>[]): DbSubscriptionRuntime => {
  /** Runtime validation narrows every dispatched payload before the heterogeneous state table invokes it. */
  const runtimeEntries = entries as unknown as readonly DbSubscriptionEntry[];
  const registeredKeys = new Set<string>();
  for (const entry of runtimeEntries) {
    if (registeredKeys.has(entry.key)) throw new Error(`Subscription entry already registered for key ${entry.key}`);
    registeredKeys.add(entry.key);
  }
  const states = runtimeEntries.map(entry => ({
    entry,
    unsubscribe: null,
    debounceBuckets: new Map<string, DebounceBucket>(),
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
  const generationFence = createGenerationFence({ lazy: true });
  const isCurrentGeneration = (): boolean => generationFence.isCurrent();

  /** Counts a delivery only once `onData` has returned without throwing - a throw must not inflate the delivered-event metric. */
  const runHandler = (state: EntryState, payload: unknown): void => {
    if (!isCurrentGeneration()) return;
    state.entry.onData(payload);
    state.eventCount += 1;
  };

  const handlePayload = (state: EntryState, payload: unknown): void => {
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

    state.debounceBuckets.set(bucketKey, { timer, payload });
  };

  const isCurrentAttempt = (state: EntryState, epoch: number, token: number): boolean =>
    active && isCurrentGeneration() && epoch === activationEpoch && state.attemptToken === token;

  const handleTransportNext = (state: EntryState, data: unknown, epoch: number, token: number): void => {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    if (!isNonArrayRecord(data)) {
      getDbLogger().debug(LOG_PREFIX, 'response skipped', { key: state.entry.key });
      return;
    }
    handlePayload(state, data[state.entry.key]);
  };

  const subscribeEntry = (state: EntryState): void => {
    if (!active || !isCurrentGeneration() || state.unsubscribe) return;

    clearRetryTimer(state);
    const subscribe = getDbTransport().subscribe;
    if (!subscribe) {
      throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
    }

    const epoch = activationEpoch;
    const token = state.attemptToken + 1;
    const placeholder = (): void => {};
    state.attemptToken = token;
    state.unsubscribe = placeholder;
    let unsubscribe: () => void;
    try {
      unsubscribe = subscribe(
        {
          query: state.entry.query,
          variables: state.entry.vars
        },
        {
          next: data => handleTransportNext(state, data, epoch, token),
          error: error => handleEntryError(state, error, epoch, token)
        }
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

  const scheduleRetry = (state: EntryState, epoch: number, token: number): void => {
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

  function handleEntryError(state: EntryState, error: unknown, epoch: number, token: number): void {
    if (!isCurrentAttempt(state, epoch, token) || !state.unsubscribe) return;
    state.errorCount += 1;
    getDbLogger().error(LOG_PREFIX, 'subscription error', { key: state.entry.key, error });
    unsubscribeEntry(state);
    scheduleRetry(state, epoch, token);
  }

  const deactivateAll = (): void => {
    for (const state of states) {
      clearRetryTimer(state);
      clearDebounceBuckets(state);
      unsubscribeEntry(state);
    }
  };

  const reset = (): void => {
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
        getDbLogger().debug(LOG_PREFIX, 'dispatch skipped', { key });
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
