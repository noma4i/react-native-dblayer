import { useCallback, useSyncExternalStore } from 'react';
import { getDbLogger } from '../core/logger';
import { registerReset } from '../core/reset';
import { createGenerationFence } from './runtimePrimitives';

export type ModelStatusPollerPhase = {
  phase: 'idle' | 'polling' | 'ready' | 'failed' | 'stalled';
  reason?: 'terminal-payload' | 'budget-exhausted' | 'stopped';
  attempts: number;
};

type PollerSession = {
  refs: number;
  intervalId: ReturnType<typeof setInterval> | null;
  attempts: number;
  inFlight: boolean;
  phase: ModelStatusPollerPhase['phase'];
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
  refresh: (id: string, options?: { resetBudget?: boolean }) => Promise<void>;
  /** Return whether an id currently has an active polling interval. */
  isPolling: (id: string) => boolean;
  /** Return the stable current phase snapshot for one id. */
  getPhase: (id: string) => ModelStatusPollerPhase;
  /** Reactively read the stable phase snapshot for one id. */
  usePhase: (id: string) => ModelStatusPollerPhase;
};

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
  const generationFence = createGenerationFence({ lazy: true });
  const isCurrentGeneration = (): boolean => generationFence.isCurrent();
  const beginGeneration = (): boolean => {
    if (!isCurrentGeneration()) return false;
    generationFence.captureNow();
    return true;
  };

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
    const session: PollerSession = { refs: 0, intervalId: null, attempts: 0, inFlight: false, phase: 'idle' };
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
    if (sessions.get(id) !== session || session.phase !== 'polling') return;
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

  const tickSession = async (id: string, session: PollerSession): Promise<void> => {
    if (!isCurrentGeneration()) return;
    if (session.inFlight || session.phase !== 'polling') return;
    if (session.attempts >= config.maxAttempts) {
      stopTerminal(id, session, 'stalled');
      return;
    }

    session.inFlight = true;
    session.attempts += 1;
    setSnapshot(id, { phase: 'polling', attempts: session.attempts });
    try {
      const result = await config.fetch(id);
      if (!isCurrentGeneration() || sessions.get(id) !== session) return;
      config.apply(id, result);
      if (!isCurrentGeneration() || sessions.get(id) !== session) return;
      const classification = config.classify?.(result) ?? null;
      if (classification) stopTerminal(id, session, classification);
    } catch (error) {
      getDbLogger().error('ModelStatusPoller', 'fetch failed', { id, attempts: session.attempts, error });
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

  const ensurePolling = (id: string, session: PollerSession): void => {
    if (session.refs <= 0 || session.phase !== 'polling' || session.intervalId) return;
    session.intervalId = setInterval(() => void tickSession(id, session), config.intervalMs);
    void tickSession(id, session);
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
      const subscribeToId = useCallback((listener: () => void) => subscribe(id, listener), [id]);
      const readPhase = useCallback(() => getPhase(id), [id]);
      return useSyncExternalStore(subscribeToId, readPhase, readPhase);
    }
  };
};
