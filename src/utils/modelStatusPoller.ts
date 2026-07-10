import { getDbLogger } from '../core/logger';

type PollerSession = {
  refs: number;
  intervalId: ReturnType<typeof setInterval> | null;
  attempts: number;
  inFlight: boolean;
  terminal: boolean;
};

type ModelStatusPollerStopReason = 'terminal' | 'budget';

export type ModelStatusPollerConfig<TResult> = {
  /** Fetch the latest status payload for an id. */
  fetch: (id: string) => Promise<TResult>;
  /** Apply a fetched status payload to the owning model. */
  apply: (id: string, result: TResult) => void;
  /** Return true when the fetched payload should stop polling this id. */
  isTerminal: (result: TResult) => boolean;
  /** Called once when a session stops because it reached a terminal payload or exhausted its budget. */
  onSessionStop?: (id: string, reason: ModelStatusPollerStopReason) => void;
  /** Interval between scheduled status refreshes. */
  intervalMs: number;
  /** Maximum number of fetch attempts before a non-terminal session stops. */
  maxAttempts: number;
};

export type ModelStatusPoller = {
  /** Attach one polling consumer to an id; the returned detach decrements the refcount and stops the last consumer. */
  attach: (id: string) => () => void;
  /** Subscribe to terminal snapshot changes without attaching a polling consumer or starting a fetch. */
  subscribe: (id: string, listener: () => void) => () => void;
  /** Run an immediate status fetch outside the interval. `resetBudget` clears terminal state and attempts. */
  refresh: (id: string, options?: { resetBudget?: boolean }) => Promise<void>;
  /** Return whether an id currently has an active polling interval. */
  isPolling: (id: string) => boolean;
  /** Return true while a retained session has stopped on a terminal payload or exhausted budget. Detached sessions are removed and return false. */
  isSessionTerminal: (id: string) => boolean;
};

/**
 * Create a refcounted per-id status poller for model-backed async status updates.
 *
 * Sessions start on first attach, stop on terminal payloads, exhausted attempt budget, or last detach,
 * and dedupe overlapping fetches per id. Fetch errors consume attempts, are logged, and never throw
 * from scheduled interval ticks.
 *
 * @param config Status fetch/apply/terminal callbacks plus interval and attempt budget.
 * @returns Refcounted attach, terminal subscription, immediate refresh, and polling-state helpers.
 */
export const createModelStatusPoller = <TResult>(config: ModelStatusPollerConfig<TResult>): ModelStatusPoller => {
  const sessions = new Map<string, PollerSession>();
  const terminalSubscribers = new Map<string, Set<() => void>>();

  const getOrCreateSession = (id: string): PollerSession => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const session: PollerSession = {
      refs: 0,
      intervalId: null,
      attempts: 0,
      inFlight: false,
      terminal: false
    };
    sessions.set(id, session);
    return session;
  };

  const stopSession = (id: string, session: PollerSession, remove: boolean): void => {
    if (session.intervalId) {
      clearInterval(session.intervalId);
      session.intervalId = null;
    }
    if (remove) {
      sessions.delete(id);
    }
  };

  const emitSessionStop = (id: string, reason: ModelStatusPollerStopReason): void => {
    if (!config.onSessionStop) return;

    try {
      config.onSessionStop(id, reason);
    } catch (error) {
      getDbLogger().error('ModelStatusPoller', 'session stop callback failed', { id, reason, error });
    }
  };

  const emitTerminalChange = (id: string): void => {
    const subscribers = terminalSubscribers.get(id);
    if (!subscribers) return;

    for (const subscriber of subscribers) {
      try {
        subscriber();
      } catch (error) {
        getDbLogger().error('ModelStatusPoller', 'terminal subscriber failed', { id, error });
      }
    }
  };

  const markSessionStopped = (id: string, session: PollerSession, reason: ModelStatusPollerStopReason): void => {
    if (sessions.get(id) !== session) return;
    if (session.terminal) return;
    session.terminal = true;
    stopSession(id, session, false);
    emitTerminalChange(id);
    emitSessionStop(id, reason);
  };

  const tickSession = async (id: string, session: PollerSession): Promise<void> => {
    if (session.inFlight || session.terminal) return;

    if (session.attempts >= config.maxAttempts) {
      markSessionStopped(id, session, 'budget');
      return;
    }

    session.inFlight = true;
    session.attempts += 1;

    try {
      const result = await config.fetch(id);
      config.apply(id, result);
      if (config.isTerminal(result)) {
        markSessionStopped(id, session, 'terminal');
      }
    } catch (error) {
      getDbLogger().error('ModelStatusPoller', 'fetch failed', { id, attempts: session.attempts, error });
    } finally {
      session.inFlight = false;
      if (!session.terminal && session.attempts >= config.maxAttempts) {
        markSessionStopped(id, session, 'budget');
      }
    }
  };

  const ensurePolling = (id: string, session: PollerSession): void => {
    if (session.refs <= 0 || session.terminal || session.intervalId) return;
    session.intervalId = setInterval(() => {
      void tickSession(id, session);
    }, config.intervalMs);
    void tickSession(id, session);
  };

  return {
    attach(id) {
      const session = getOrCreateSession(id);
      session.refs += 1;
      ensurePolling(id, session);

      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        session.refs = Math.max(0, session.refs - 1);
        if (session.refs === 0) {
          const wasTerminal = session.terminal;
          stopSession(id, session, true);
          if (wasTerminal) {
            emitTerminalChange(id);
          }
        }
      };
    },
    subscribe(id, listener) {
      const subscribers = terminalSubscribers.get(id) ?? new Set<() => void>();
      subscribers.add(listener);
      terminalSubscribers.set(id, subscribers);

      return () => {
        const currentSubscribers = terminalSubscribers.get(id);
        if (!currentSubscribers) return;
        currentSubscribers.delete(listener);
        if (currentSubscribers.size === 0) {
          terminalSubscribers.delete(id);
        }
      };
    },
    async refresh(id, options) {
      const session = getOrCreateSession(id);
      if (options?.resetBudget) {
        const wasTerminal = session.terminal;
        session.attempts = 0;
        session.terminal = false;
        if (wasTerminal) {
          emitTerminalChange(id);
        }
      }
      await tickSession(id, session);
      ensurePolling(id, session);
    },
    isPolling(id) {
      const session = sessions.get(id);
      return Boolean(session?.intervalId && !session.terminal && session.refs > 0);
    },
    isSessionTerminal(id) {
      return sessions.get(id)?.terminal === true;
    }
  };
};
