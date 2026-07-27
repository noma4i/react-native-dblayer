import type { ResultOf, TypedDocumentNode, VariablesOf } from '@graphql-typed-document-node/core';
import type { DbGraphQLDocument } from '../types';

/** Static subscription registration consumed by `createDbSubscriptionRuntime`. */
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

/** Typed authoring form for a static subscription registration. */
export type TypedDbSubscriptionEntry<TDocument extends TypedDocumentNode<unknown, never>, TKey extends Extract<keyof ResultOf<TDocument>, string>> = Omit<
  DbSubscriptionEntry<ResultOf<TDocument>[TKey]>,
  'key' | 'query' | 'vars'
> & {
  key: TKey;
  query: TDocument;
  vars?: VariablesOf<TDocument>;
};

/** Effects channel returned by `createDbSubscriptionEffects`. */
export type DbSubscriptionEffectsChannel<TEffects extends Record<keyof TEffects, (...args: never[]) => void>> = {
  /** Stable wrapper table with the same keys as the noop table. */
  effects: TEffects;
  /** Replace active effects; keys omitted from `overrides` fall back to the noop implementation. */
  configure: (overrides: Partial<TEffects>) => void;
  /** Restore every effect to its noop implementation and unregister this channel's named effects. */
  reset: () => void;
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
  /** Activate or deactivate all registered transport subscriptions. */
  setActive(active: boolean): void;
  /** Read the runtime-wide active flag. */
  isActive(): boolean;
  /** Manually inject a payload into the transport event pipeline. */
  dispatch(key: string, payload: unknown): void;
  /** Inspect runtime counters for every registered entry. */
  inspect(): DbSubscriptionRuntimeInspectRow[];
  /** Final teardown for transport subscriptions and pending debounce/retry timers. */
  stop(): void;
};
