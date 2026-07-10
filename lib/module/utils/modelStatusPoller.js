"use strict";

import { getDbLogger } from "../core/logger.js";
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
export const createModelStatusPoller = config => {
  const sessions = new Map();
  const terminalSubscribers = new Map();
  const getOrCreateSession = id => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const session = {
      refs: 0,
      intervalId: null,
      attempts: 0,
      inFlight: false,
      terminal: false
    };
    sessions.set(id, session);
    return session;
  };
  const stopSession = (id, session, remove) => {
    if (session.intervalId) {
      clearInterval(session.intervalId);
      session.intervalId = null;
    }
    if (remove) {
      sessions.delete(id);
    }
  };
  const emitSessionStop = (id, reason) => {
    if (!config.onSessionStop) return;
    try {
      config.onSessionStop(id, reason);
    } catch (error) {
      getDbLogger().error('ModelStatusPoller', 'session stop callback failed', {
        id,
        reason,
        error
      });
    }
  };
  const emitTerminalChange = id => {
    const subscribers = terminalSubscribers.get(id);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      try {
        subscriber();
      } catch (error) {
        getDbLogger().error('ModelStatusPoller', 'terminal subscriber failed', {
          id,
          error
        });
      }
    }
  };
  const markSessionStopped = (id, session, reason) => {
    if (sessions.get(id) !== session) return;
    if (session.terminal) return;
    session.terminal = true;
    stopSession(id, session, false);
    emitTerminalChange(id);
    emitSessionStop(id, reason);
  };
  const tickSession = async (id, session) => {
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
      getDbLogger().error('ModelStatusPoller', 'fetch failed', {
        id,
        attempts: session.attempts,
        error
      });
    } finally {
      session.inFlight = false;
      if (!session.terminal && session.attempts >= config.maxAttempts) {
        markSessionStopped(id, session, 'budget');
      }
    }
  };
  const ensurePolling = (id, session) => {
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
      const subscribers = terminalSubscribers.get(id) ?? new Set();
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
//# sourceMappingURL=modelStatusPoller.js.map