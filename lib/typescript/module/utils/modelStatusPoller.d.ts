export type ModelStatusPollerConfig<TResult> = {
    /** Fetch the latest status payload for an id. */
    fetch: (id: string) => Promise<TResult>;
    /** Apply a fetched status payload to the owning model. */
    apply: (id: string, result: TResult) => void;
    /** Return true when the fetched payload should stop polling this id. */
    isTerminal: (result: TResult) => boolean;
    /** Interval between scheduled status refreshes. */
    intervalMs: number;
    /** Maximum number of fetch attempts before a non-terminal session stops. */
    maxAttempts: number;
};
export type ModelStatusPoller = {
    /** Attach one listener to an id; the returned detach decrements the refcount and stops the last listener. */
    attach: (id: string) => () => void;
    /** Run an immediate status fetch outside the interval. `resetBudget` clears terminal state and attempts. */
    refresh: (id: string, options?: {
        resetBudget?: boolean;
    }) => Promise<void>;
    /** Return whether an id currently has an active polling interval. */
    isPolling: (id: string) => boolean;
};
/**
 * Create a refcounted per-id status poller for model-backed async status updates.
 *
 * Sessions start on first attach, stop on terminal payloads, exhausted attempt budget, or last detach,
 * and dedupe overlapping fetches per id. Fetch errors consume attempts, are logged, and never throw
 * from scheduled interval ticks.
 *
 * @param config Status fetch/apply/terminal callbacks plus interval and attempt budget.
 * @returns Refcounted attach, immediate refresh, and polling-state helpers.
 */
export declare const createModelStatusPoller: <TResult>(config: ModelStatusPollerConfig<TResult>) => ModelStatusPoller;
//# sourceMappingURL=modelStatusPoller.d.ts.map