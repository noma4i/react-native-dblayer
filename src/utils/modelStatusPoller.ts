import { union } from 'es-toolkit';
import { useCallback, useSyncExternalStore } from 'react';
import { getDbLogger } from '../core/logger';
import { registerReset } from '../core/reset';
import { createSingleFlight } from './singleFlight';

import type { ModelStatusPoller, ModelStatusPollerConfig, ModelStatusPollerPhase, ModelStatusPollerStopReason, PollerSession } from '../types';

const IDLE_PHASE: ModelStatusPollerPhase = { phase: 'idle', attempts: 0 };

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
export const createModelStatusPoller = <TResult>(config: ModelStatusPollerConfig<TResult>): ModelStatusPoller => {
  const sessions = new Map<string, PollerSession>();
  const snapshots = new Map<string, ModelStatusPollerPhase>();
  const subscribers = new Map<string, Set<() => void>>();

  const emit = (id: string): void => {
    for (const subscriber of subscribers.get(id) ?? []) {
      try {
        subscriber();
      } catch (error) {
        getDbLogger().error('ModelStatusPoller', 'phase subscriber failed', { id, error });
      }
    }
  };

  const setSnapshot = (id: string, next: ModelStatusPollerPhase): void => {
    const current = snapshots.get(id) ?? IDLE_PHASE;
    if (current.phase === next.phase && current.reason === next.reason && current.attempts === next.attempts) return;
    snapshots.set(id, next);
    emit(id);
  };

  const getOrCreateSession = (id: string): PollerSession => {
    const existing = sessions.get(id);
    if (existing) return existing;
    const session = { refs: 0, intervalId: null, attempts: 0, phase: 'idle' } as PollerSession;
    session.runTick = createSingleFlight(() => runFetch(id, session));
    sessions.set(id, session);
    return session;
  };

  const clearTimer = (session: PollerSession): void => {
    if (!session.intervalId) return;
    clearInterval(session.intervalId);
    session.intervalId = null;
  };

  const emitSessionStop = (id: string, reason: ModelStatusPollerStopReason): void => {
    if (!config.onSessionStop) return;
    try {
      config.onSessionStop(id, reason);
    } catch (error) {
      getDbLogger().error('ModelStatusPoller', 'session stop callback failed', { id, reason, error });
    }
  };

  const setPolling = (id: string, session: PollerSession): void => {
    session.phase = 'polling';
    setSnapshot(id, { phase: 'polling', attempts: session.attempts });
  };

  const stopTerminal = (id: string, session: PollerSession, phase: 'ready' | 'failed' | 'stalled'): void => {
    clearTimer(session);
    session.phase = phase;
    const reason = phase === 'stalled' ? 'budget-exhausted' : 'terminal-payload';
    setSnapshot(id, { phase, reason, attempts: session.attempts });
    emitSessionStop(id, reason);
  };

  const stopDetached = (id: string, session: PollerSession): void => {
    const wasPolling = session.phase === 'polling';
    clearTimer(session);
    sessions.delete(id);
    setSnapshot(id, { phase: 'idle', reason: 'stopped', attempts: session.attempts });
    if (wasPolling) emitSessionStop(id, 'stopped');
  };

  /**
   * The actual tick body, single-flighted per session: overlapping callers (interval tick, explicit
   * refresh) share this one execution instead of re-entering, so the phase/attempts guards below run
   * exactly once per real fetch.
   */
  const runFetch = async (id: string, session: PollerSession): Promise<void> => {
    if (session.phase !== 'polling') return;
    if (session.attempts >= config.maxAttempts) {
      stopTerminal(id, session, 'stalled');
      return;
    }

    session.attempts += 1;
    setSnapshot(id, { phase: 'polling', attempts: session.attempts });
    try {
      const result = await config.fetch(id);
      // Session identity is the staleness gate: reset/detach clears `sessions`, so a fetch that
      // resolves after either can never touch a session it no longer owns.
      if (sessions.get(id) !== session) return;
      config.apply(id, result);
      if (sessions.get(id) !== session) return;
      const classification = config.classify?.(result) ?? null;
      if (classification) stopTerminal(id, session, classification);
    } catch (error) {
      getDbLogger().error('ModelStatusPoller', 'fetch failed', { id, attempts: session.attempts, error });
    } finally {
      if (sessions.get(id) !== session) return;
      if (session.phase === 'polling' && session.attempts >= config.maxAttempts) {
        stopTerminal(id, session, 'stalled');
      } else if (session.phase === 'polling' && session.refs === 0) {
        stopDetached(id, session);
      }
    }
  };

  const tickSession = (session: PollerSession): Promise<void> => session.runTick();

  const ensurePolling = (session: PollerSession): void => {
    if (session.refs <= 0 || session.phase !== 'polling' || session.intervalId) return;
    session.intervalId = setInterval(() => void tickSession(session), config.intervalMs);
    void tickSession(session);
  };

  const subscribe = (id: string, listener: () => void): (() => void) => {
    const listeners = subscribers.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    subscribers.set(id, listeners);
    return () => {
      const current = subscribers.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) subscribers.delete(id);
    };
  };

  const getPhase = (id: string): ModelStatusPollerPhase => snapshots.get(id) ?? IDLE_PHASE;

  registerReset(() => {
    const ids = union([...sessions.keys()], [...snapshots.keys()]);
    for (const session of sessions.values()) clearTimer(session);
    sessions.clear();
    snapshots.clear();
    for (const id of ids) emit(id);
  });

  return {
    attach(id) {
      const session = getOrCreateSession(id);
      if (session.phase === 'idle') setPolling(id, session);
      session.refs += 1;
      ensurePolling(session);

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
      const session = getOrCreateSession(id);
      if (options?.resetBudget) {
        session.attempts = 0;
        setPolling(id, session);
      } else if (session.phase === 'idle') {
        setPolling(id, session);
      }
      await tickSession(session);
      ensurePolling(session);
    },
    isPolling(id) {
      const session = sessions.get(id);
      return Boolean(session?.intervalId && session.phase === 'polling' && session.refs > 0);
    },
    getPhase,
    usePhase(id) {
      const subscribeToId = useCallback((listener: () => void) => subscribe(id, listener), [id]);
      const readPhase = useCallback(() => getPhase(id), [id]);
      return useSyncExternalStore(subscribeToId, readPhase, readPhase);
    }
  };
};
