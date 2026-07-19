"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createModelStatusPoller = void 0;
var _react = require("react");
var _logger = require("../core/logger.js");
var _reset = require("../core/reset.js");
var _runtimePrimitives = require("./runtimePrimitives.js");
const IDLE_PHASE = {
  phase: 'idle',
  attempts: 0
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
const createModelStatusPoller = config => {
  const sessions = new Map();
  const snapshots = new Map();
  const subscribers = new Map();
  const generationFence = (0, _runtimePrimitives.createGenerationFence)({
    lazy: true
  });
  const isCurrentGeneration = () => generationFence.isCurrent();
  const beginGeneration = () => {
    if (!isCurrentGeneration()) return false;
    generationFence.captureNow();
    return true;
  };
  const emit = id => {
    for (const subscriber of subscribers.get(id) ?? []) {
      try {
        subscriber();
      } catch (error) {
        (0, _logger.getDbLogger)().error('ModelStatusPoller', 'phase subscriber failed', {
          id,
          error
        });
      }
    }
  };
  const setSnapshot = (id, next) => {
    const current = snapshots.get(id) ?? IDLE_PHASE;
    if (current.phase === next.phase && current.reason === next.reason && current.attempts === next.attempts) return;
    snapshots.set(id, next);
    emit(id);
  };
  const getOrCreateSession = id => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const session = {
      refs: 0,
      intervalId: null,
      attempts: 0,
      inFlight: false,
      phase: 'idle'
    };
    sessions.set(id, session);
    return session;
  };
  const clearTimer = session => {
    if (!session.intervalId) return;
    clearInterval(session.intervalId);
    session.intervalId = null;
  };
  const emitSessionStop = (id, reason) => {
    if (!config.onSessionStop) return;
    try {
      config.onSessionStop(id, reason);
    } catch (error) {
      (0, _logger.getDbLogger)().error('ModelStatusPoller', 'session stop callback failed', {
        id,
        reason,
        error
      });
    }
  };
  const setPolling = (id, session) => {
    session.phase = 'polling';
    setSnapshot(id, {
      phase: 'polling',
      attempts: session.attempts
    });
  };
  const stopTerminal = (id, session, phase) => {
    if (sessions.get(id) !== session || session.phase !== 'polling') return;
    clearTimer(session);
    session.phase = phase;
    const reason = phase === 'stalled' ? 'budget-exhausted' : 'terminal-payload';
    setSnapshot(id, {
      phase,
      reason,
      attempts: session.attempts
    });
    emitSessionStop(id, reason);
  };
  const stopDetached = (id, session) => {
    const wasPolling = session.phase === 'polling';
    clearTimer(session);
    sessions.delete(id);
    setSnapshot(id, {
      phase: 'idle',
      reason: 'stopped',
      attempts: session.attempts
    });
    if (wasPolling) emitSessionStop(id, 'stopped');
  };
  const tickSession = async (id, session) => {
    if (!isCurrentGeneration()) return;
    if (session.inFlight || session.phase !== 'polling') return;
    if (session.attempts >= config.maxAttempts) {
      stopTerminal(id, session, 'stalled');
      return;
    }
    session.inFlight = true;
    session.attempts += 1;
    setSnapshot(id, {
      phase: 'polling',
      attempts: session.attempts
    });
    try {
      const result = await config.fetch(id);
      if (!isCurrentGeneration() || sessions.get(id) !== session) return;
      config.apply(id, result);
      if (!isCurrentGeneration() || sessions.get(id) !== session) return;
      const classification = config.classify?.(result) ?? null;
      if (classification) stopTerminal(id, session, classification);
    } catch (error) {
      (0, _logger.getDbLogger)().error('ModelStatusPoller', 'fetch failed', {
        id,
        attempts: session.attempts,
        error
      });
    } finally {
      session.inFlight = false;
      if (!isCurrentGeneration() || sessions.get(id) !== session) return;
      if (session.phase === 'polling' && session.attempts >= config.maxAttempts) {
        stopTerminal(id, session, 'stalled');
      } else if (session.phase === 'polling' && session.refs === 0) {
        stopDetached(id, session);
      }
    }
  };
  const ensurePolling = (id, session) => {
    if (session.refs <= 0 || session.phase !== 'polling' || session.intervalId) return;
    session.intervalId = setInterval(() => void tickSession(id, session), config.intervalMs);
    void tickSession(id, session);
  };
  const subscribe = (id, listener) => {
    const listeners = subscribers.get(id) ?? new Set();
    listeners.add(listener);
    subscribers.set(id, listeners);
    return () => {
      const current = subscribers.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) subscribers.delete(id);
    };
  };
  const getPhase = id => snapshots.get(id) ?? IDLE_PHASE;
  (0, _reset.registerReset)(() => {
    const ids = new Set([...sessions.keys(), ...snapshots.keys()]);
    for (const session of sessions.values()) clearTimer(session);
    sessions.clear();
    snapshots.clear();
    for (const id of ids) emit(id);
  });
  return {
    attach(id) {
      if (!beginGeneration()) return () => {};
      const session = getOrCreateSession(id);
      if (session.phase === 'idle') setPolling(id, session);
      session.refs += 1;
      ensurePolling(id, session);
      let detached = false;
      return () => {
        if (detached || sessions.get(id) !== session) return;
        detached = true;
        session.refs = Math.max(0, session.refs - 1);
        if (session.refs === 0) stopDetached(id, session);
      };
    },
    subscribe,
    async refresh(id, options) {
      if (!beginGeneration()) return;
      const session = getOrCreateSession(id);
      if (options?.resetBudget) {
        session.attempts = 0;
        setPolling(id, session);
      } else if (session.phase === 'idle') {
        setPolling(id, session);
      }
      await tickSession(id, session);
      ensurePolling(id, session);
    },
    isPolling(id) {
      const session = sessions.get(id);
      return Boolean(session?.intervalId && session.phase === 'polling' && session.refs > 0);
    },
    getPhase,
    usePhase(id) {
      const subscribeToId = (0, _react.useCallback)(listener => subscribe(id, listener), [id]);
      const readPhase = (0, _react.useCallback)(() => getPhase(id), [id]);
      return (0, _react.useSyncExternalStore)(subscribeToId, readPhase, readPhase);
    }
  };
};
exports.createModelStatusPoller = createModelStatusPoller;
//# sourceMappingURL=modelStatusPoller.js.map