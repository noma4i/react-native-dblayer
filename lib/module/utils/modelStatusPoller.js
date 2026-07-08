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
 * @returns Refcounted attach, immediate refresh, and polling-state helpers.
 */
export const createModelStatusPoller = config => {
  const sessions = new Map();
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
  const tickSession = async (id, session) => {
    if (session.inFlight || session.terminal) return;
    if (session.attempts >= config.maxAttempts) {
      session.terminal = true;
      stopSession(id, session, false);
      return;
    }
    session.inFlight = true;
    session.attempts += 1;
    try {
      const result = await config.fetch(id);
      config.apply(id, result);
      if (config.isTerminal(result)) {
        session.terminal = true;
        stopSession(id, session, false);
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
        session.terminal = true;
        stopSession(id, session, false);
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
          stopSession(id, session, true);
        }
      };
    },
    async refresh(id, options) {
      const session = getOrCreateSession(id);
      if (options?.resetBudget) {
        session.attempts = 0;
        session.terminal = false;
      }
      await tickSession(id, session);
      ensurePolling(id, session);
    },
    isPolling(id) {
      const session = sessions.get(id);
      return Boolean(session?.intervalId && !session.terminal && session.refs > 0);
    }
  };
};
//# sourceMappingURL=modelStatusPoller.js.map