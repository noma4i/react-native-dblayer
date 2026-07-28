export type ModelStatusPollerPhase = {
    phase: 'idle' | 'polling' | 'ready' | 'failed' | 'stalled';
    reason?: 'terminal-payload' | 'budget-exhausted' | 'stopped';
    attempts: number;
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
//# sourceMappingURL=utils.modelStatusPoller.types.d.ts.map