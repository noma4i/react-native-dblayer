import type { ResultOf, TypedDocumentNode, VariablesOf } from '@graphql-typed-document-node/core';
import { getDbLogger } from './logger';
import { getDbTransport } from './transport';
import type { DbGraphQLDocument } from '../types';
import { isNonArrayRecord } from '../utils/normalizeHelpers';
import { getRuntimeGeneration } from '../dsl/configure';

const LOG_PREFIX = 'DbSubscriptionRuntime';
const GLOBAL_DEBOUNCE_KEY = '__global__';
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const namedEffects = new Map<string, (...args: unknown[]) => void>();

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

type TypedDbSubscriptionEntry<
  TDocument extends TypedDocumentNode<any, any>,
  TKey extends Extract<keyof ResultOf<TDocument>, string>
> = Omit<DbSubscriptionEntry<ResultOf<TDocument>[TKey]>, 'key' | 'query' | 'vars'> & {
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
export const defineDbSubscriptionEntry = <
  TDocument extends TypedDocumentNode<any, any>,
  TKey extends Extract<keyof ResultOf<TDocument>, string>
>(
  entry: TypedDbSubscriptionEntry<TDocument, TKey>
): DbSubscriptionEntry => entry as unknown as DbSubscriptionEntry;

/** Function table of UI effects invoked by subscription entries. */
export type DbSubscriptionEffectsTable = Record<string, (...args: any[]) => void>;

/** Effects channel returned by `createDbSubscriptionEffects`. */
export type DbSubscriptionEffectsChannel<TEffects extends Record<keyof TEffects, (...args: any[]) => void>> = {
  /**
   * Stable wrapper table with the same keys as the noop table. Each wrapper forwards to the currently
   * configured effect. The table and every wrapper keep one identity for the channel's lifetime, so
   * subscription entries can capture them at build time and never rebind.
   */
  effects: TEffects;
  /** Replace active effects; keys omitted from `overrides` fall back to the noop implementation. */
  configure: (overrides: Partial<TEffects>) => void;
  /** Restore every effect to its noop implementation. */
  reset: () => void;
};

/**
 * Create an injectable effects channel for subscription entries.
 *
 * Entries call `channel.effects.onX(...)` where a UI reaction is needed; the app injects real
 * implementations with `configure` when its effect owner mounts and calls `reset` on teardown.
 *
 * @param noopEffects Complete effect table with no-op implementations; defines the channel's keys.
 * @returns Stable `effects` table plus `configure`/`reset` controls.
 */
export const createDbSubscriptionEffects = <TEffects extends Record<keyof TEffects, (...args: any[]) => void>>(noopEffects: TEffects): DbSubscriptionEffectsChannel<TEffects> => {
  let activeEffects: TEffects = noopEffects;

  const effects = Object.fromEntries(
    Object.keys(noopEffects).map(key => [
      key,
      (...args: unknown[]) => {
        (activeEffects[key as keyof TEffects] as (...forwarded: unknown[]) => void)(...args);
      }
    ])
  ) as TEffects;
  for (const [name, effect] of Object.entries(effects)) namedEffects.set(name, effect as (...args: unknown[]) => void);

  return {
    effects,
    configure: overrides => {
      activeEffects = { ...noopEffects, ...overrides } as TEffects;
    },
    reset: () => {
      activeEffects = noopEffects;
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
   * observer resubscription inside the transport remain transparent to this runtime.
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

type RuntimeEntry = DbSubscriptionEntry<any>;

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
  const states = entries.map(entry => ({
    entry,
    unsubscribe: null,
    debounceBuckets: new Map<string, DebounceBucket>(),
    retryTimer: null,
    retryAttempts: 0,
    eventCount: 0,
    lastEventAt: null,
    errorCount: 0
  }));
  const byKey = new Map(states.map(state => [state.entry.key, state]));
  let active = false;
  let activeGeneration: number | null = null;

  const isCurrentGeneration = (): boolean => activeGeneration == null || activeGeneration === getRuntimeGeneration();

  const runHandler = (state: EntryState, payload: unknown): void => {
    if (!isCurrentGeneration()) return;
    state.entry.onData(payload);
  };

  const handlePayload = (state: EntryState, payload: unknown): void => {
    if (!isCurrentGeneration()) return;
    if (!isNonArrayRecord(payload)) {
      getDbLogger().debug(LOG_PREFIX, 'payload skipped', { key: state.entry.key });
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

    state.debounceBuckets.set(bucketKey, { timer, payload });
  };

  const handleTransportNext = (state: EntryState, data: unknown): void => {
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

    state.unsubscribe = subscribe(
      {
        query: state.entry.query,
        variables: state.entry.vars
      },
      {
        next: data => handleTransportNext(state, data),
        error: error => handleEntryError(state, error)
      }
    );
  };

  const scheduleRetry = (state: EntryState): void => {
    if (!active) return;
    clearRetryTimer(state);
    const delay = nextRetryDelay(state.retryAttempts);
    state.retryAttempts += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      subscribeEntry(state);
    }, delay);
  };

  function handleEntryError(state: EntryState, error: unknown): void {
    state.errorCount += 1;
    getDbLogger().error(LOG_PREFIX, 'subscription error', { key: state.entry.key, error });
    unsubscribeEntry(state);
    scheduleRetry(state);
  }

  const deactivateAll = (): void => {
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
        activeGeneration = null;
        deactivateAll();
        return;
      }

      const subscribe = getDbTransport().subscribe;
      if (!subscribe) {
        throw new Error('react-native-dblayer: transport.subscribe is required before activating subscription runtime');
      }

      active = true;
      activeGeneration = getRuntimeGeneration();
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
      active = false;
      activeGeneration = null;
      deactivateAll();
    }
  };
};
