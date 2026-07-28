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
  refresh: (id: string, options?: { resetBudget?: boolean }) => Promise<void>;
  /** Return whether an id currently has an active polling interval. */
  isPolling: (id: string) => boolean;
  /** Return the stable current phase snapshot for one id. */
  getPhase: (id: string) => ModelStatusPollerPhase;
  /** Reactively read the stable phase snapshot for one id. */
  usePhase: (id: string) => ModelStatusPollerPhase;
};

/** One live polling session: refcount, schedule, attempt budget and single-flighted tick. */
export type PollerSession = {
  refs: number;
  intervalId: ReturnType<typeof setInterval> | null;
  attempts: number;
  /** Single-flighted tick runner: overlapping callers share the one in-flight fetch instead of re-entering. */
  runTick: () => Promise<void>;
  phase: ModelStatusPollerPhase['phase'];
};

/** Why a polling session stopped: terminal payload, exhausted budget, or detach. */
export type ModelStatusPollerStopReason = NonNullable<ModelStatusPollerPhase['reason']>;

/** `Model.poller` configuration: fetch/apply pair, terminal classification, cadence and budget. */
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
