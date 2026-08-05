import type { Debouncer } from '@tanstack/pacer';
import type { DbGraphQLDocument } from './db.types';
import type { ModelRootOwner, ModelRootPlan } from './dsl.modelRoot.types';
import type { WritePlan } from './dsl.writePlan.types';
/** Static subscription registration consumed by `createModelEventLifecycle`. */
export type ModelEventLifecycleEntry<TPayload = unknown> = {
    /** Stable registry id for this subscription entry. */
    key: string;
    /** Response key under transport data, or `key` when omitted. */
    payloadKey?: string;
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
        /** Optional reducer for lossless coalescing inside one bucket. Omit to keep latest-payload semantics. */
        merge?: (previous: TPayload, incoming: TPayload) => TPayload;
    };
    /** Reconcile authoritative state after each successful transport subscription, including retries. */
    onSubscribe?: () => void;
    /** Handler invoked with a validated payload after debounce, if configured. */
    onData: (payload: TPayload) => void;
};
/** Runtime inspection row for a registered subscription entry. */
export type ModelEventLifecycleInspectRow = {
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
/** Runtime controller returned by `createModelEventLifecycle`. */
export type ModelEventLifecycle = {
    /** Activate or deactivate all registered transport subscriptions. */
    setActive(active: boolean): void;
    /** Read the runtime-wide active flag. */
    isActive(): boolean;
    /** Inspect runtime counters for every registered entry. */
    inspect(): ModelEventLifecycleInspectRow[];
    /** Final teardown for transport subscriptions and pending debounce/retry timers. */
    stop(): void;
};
/** Live state for one subscription entry: channel handle, pacing buckets, retry and telemetry. */
export type SubscriptionEntryState = {
    entry: ModelEventLifecycleEntry;
    unsubscribe: (() => void) | null;
    debounceBuckets: Map<string, Debouncer<(payload: unknown) => void>>;
    debouncePayloads: Map<string, unknown>;
    retryTimer: ReturnType<typeof setTimeout> | null;
    retryNetworkRelease: (() => void) | null;
    retryAttempts: number;
    eventCount: number;
    lastEventAt: number | null;
    errorCount: number;
    attemptToken: number;
};
/** One lifecycle runtime: entries plus activation state and the generation fence. */
export type SubscriptionLifecycleContext = {
    states: SubscriptionEntryState[];
    active: boolean;
    activationEpoch: number;
    generationFence: {
        isCurrent(): boolean;
        captureNow(): void;
    };
};
export type ModelEventSubscription<TPayload> = {
    subscribe(listener: (payload: TPayload) => void): () => void;
};
export type ModelEventRegistration<TPayload, TInput = unknown, TStored extends {
    id: string;
} = {
    id: string;
}, TOwnerKey extends string = string> = {
    modelKey: string;
    eventName: string;
    document: DbGraphQLDocument;
    variables?: Record<string, unknown>;
    debounce?: ModelEventLifecycleEntry<TPayload>['debounce'];
    owner: ModelRootOwner<TInput>;
    root: ModelRootPlan<{
        payload: TPayload;
    }, TInput, TStored>;
    write?: (context: {
        payload: TPayload;
    }, plan: WritePlan<TOwnerKey>) => void;
};
//# sourceMappingURL=subscription.types.d.ts.map