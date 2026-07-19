import type { ResultOf, TypedDocumentNode, VariablesOf } from '@graphql-typed-document-node/core';
import type { DbGraphQLDocument } from '../types';
/** Clear injected effect wrappers during runtime teardown. */
export declare const resetSubscriptionRuntimeEffects: () => void;
/** Resolve an injected subscription effect by its stable application name. */
export declare const getDbSubscriptionEffect: (name: string) => ((...args: unknown[]) => void) | undefined;
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
type TypedDbSubscriptionEntry<TDocument extends TypedDocumentNode<unknown, unknown>, TKey extends Extract<keyof ResultOf<TDocument>, string>> = Omit<
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
export declare const defineDbSubscriptionEntry: <TDocument extends TypedDocumentNode<unknown, unknown>, TKey extends Extract<keyof ResultOf<TDocument>, string>>(
  entry: TypedDbSubscriptionEntry<TDocument, TKey>
) => DbSubscriptionEntry;
/** Function table of UI effects invoked by subscription entries. */
export type DbSubscriptionEffectsTable = Record<string, (...args: never[]) => void>;
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
export declare const createDbSubscriptionEffects: <TEffects extends Record<keyof TEffects, (...args: never[]) => void>>(
  noopEffects: TEffects
) => DbSubscriptionEffectsChannel<TEffects>;
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
/**
 * Create a plain subscription runtime over the configured DB transport.
 *
 * @param entries Static subscription entries. Variables are read once from each entry when subscribing.
 * @returns Runtime controller for activation, manual dispatch, inspection, and teardown.
 */
export declare const createDbSubscriptionRuntime: <TPayload = unknown>(entries: readonly DbSubscriptionEntry<TPayload>[]) => DbSubscriptionRuntime;
export {};
//# sourceMappingURL=subscriptionRuntime.d.ts.map
