export type ModelStatusPollerPhase = {
    phase: 'idle' | 'polling' | 'ready' | 'failed' | 'stalled';
    reason?: 'terminal-payload' | 'budget-exhausted' | 'stopped';
    attempts: number;
};
type ModelStatusPollerStopReason = NonNullable<ModelStatusPollerPhase['reason']>;
export type ModelStatusPollerConfig<TResult> = {
    /** Fetch the latest status payload for an id. */
    fetch: (id: string) => Promise<TResult>;
    /** Apply a fetched status payload to the owning model. */
    apply: (id: string, result: TResult) => void;
    /** Classify a fetched payload as ready, failed, or non-terminal. */
    classify?: (result: TResult) => 'ready' | 'failed' | null;
    /** Called once when a session reaches a terminal payload, exhausts its budget, or is detached. */
    onSessionStop?: (id: string, reason: ModelStatusPollerStopReason) => void;
    /** Interval between scheduled status refreshes. */
    intervalMs: number;
    /** Maximum number of fetch attempts before a non-terminal session stalls. */
    maxAttempts: number;
};
export type ModelStatusPoller = {
    /** Attach one polling consumer to an id; the returned detach decrements the refcount and stops the last consumer. */
    attach: (id: string) => () => void;
    /** Subscribe to phase snapshot changes for one id without attaching a polling consumer. */
    subscribe: (id: string, listener: () => void) => () => void;
    /** Run an immediate status fetch outside the interval. `resetBudget` restarts terminal or stalled state. */
    refresh: (id: string, options?: {
        resetBudget?: boolean;
    }) => Promise<void>;
    /** Return whether an id currently has an active polling interval. */
    isPolling: (id: string) => boolean;
    /** Return the stable current phase snapshot for one id. */
    getPhase: (id: string) => ModelStatusPollerPhase;
    /** Reactively read the stable phase snapshot for one id. */
    usePhase: (id: string) => ModelStatusPollerPhase;
};
/**
 * Create a refcounted per-id status poller for model-backed async status updates.
 *
 * Sessions start on first attach, stop on classified payloads, exhausted attempt budget, reset, or
 * last detach, and dedupe overlapping fetches per id. Fetch errors consume attempts, are logged,
 * and never throw from scheduled interval ticks.
 *
 * @param config Status fetch, apply, classification, interval, and attempt-budget callbacks.
 * @returns Refcounted polling controls plus stable synchronous and reactive phase snapshots.
 */
export declare const createModelStatusPoller: <TResult>(config: ModelStatusPollerConfig<TResult>) => ModelStatusPoller;
export {};
//# sourceMappingURL=modelStatusPoller.d.ts.map