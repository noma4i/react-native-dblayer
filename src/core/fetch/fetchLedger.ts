import type { DbRetryPolicy } from '../../types';
import { registerReset } from '../reset';
import { createGenerationFence } from '../../utils/runtimeGeneration';

type FetchKey = string;

type FetchEntry = {
  /** Epoch ms of the last outcome successfully applied to the store; null if never. */
  lastAppliedAt: number | null;
  /** Size of the last applied result; 0 is meaningful, null means never applied. */
  lastCount: number | null;
};

type RunOutcome = { applied: true; count: number } | { applied: false };

type RunStatus = 'applied' | 'skipped' | 'offline' | 'failed';

type RunContext = {
  attempt: number;
  /** False once the runtime generation moved on; the caller must not apply anything when false. */
  isCurrent: () => boolean;
};

type FetchLedger = {
  read(key: FetchKey): Readonly<FetchEntry> | undefined;
  /** True when `lastAppliedAt` is within `staleTimeMs` of `now()`. False when never applied. */
  isFresh(key: FetchKey, staleTimeMs: number): boolean;
  /** Single-flight per key, retry policy, offline gate; stamps only on applied-while-current. */
  run(key: FetchKey, execute: (ctx: RunContext) => Promise<RunOutcome>): Promise<RunStatus>;
  /** Drop freshness so the next read refetches. */
  invalidate(key: FetchKey): void;
  /** Drop freshness because committed rows behind this key were destroyed, evicted, or trimmed. */
  noteRowsLost(key: FetchKey): void;
  reset(): void;
};

/** Create a key-scoped freshness ledger for injected fetch work. */
export const createFetchLedger = (options: {
  now: () => number;
  retry: DbRetryPolicy;
  isOnline: () => boolean;
  /** Called whenever an entry's freshness changes. */
  onStamp: (key: FetchKey) => void;
}): FetchLedger => {
  const entries = new Map<FetchKey, FetchEntry>();
  const flights = new Map<FetchKey, Promise<RunStatus>>();

  const clearEntry = (key: FetchKey): void => {
    if (!entries.delete(key)) return;
    options.onStamp(key);
  };

  const reset = (): void => {
    entries.clear();
    flights.clear();
  };

  registerReset(reset);

  return {
    read: key => entries.get(key),
    isFresh: (key, staleTimeMs) => {
      const lastAppliedAt = entries.get(key)?.lastAppliedAt;
      return lastAppliedAt !== undefined && lastAppliedAt !== null && options.now() - lastAppliedAt <= staleTimeMs;
    },
    run: (key, execute) => {
      const existing = flights.get(key);
      if (existing) return existing;
      if (!options.isOnline()) return Promise.resolve('offline');

      const generationFence = createGenerationFence();
      const flight = (async (): Promise<RunStatus> => {
        let attempt = 1;
        while (true) {
          try {
            const outcome = await execute({ attempt, isCurrent: generationFence.isCurrent });
            if (!outcome.applied || !generationFence.isCurrent()) return 'skipped';

            const next = { lastAppliedAt: options.now(), lastCount: outcome.count };
            const previous = entries.get(key);
            entries.set(key, next);
            if (previous?.lastAppliedAt !== next.lastAppliedAt || previous.lastCount !== next.lastCount) options.onStamp(key);
            return 'applied';
          } catch (error) {
            const classification = options.retry.classify?.(error) ?? 'fatal';
            if (classification === 'fatal' || attempt > (options.retry.budgets?.[classification] ?? 0)) return 'failed';
            const baseMs = options.retry.backoff?.baseMs ?? 1000;
            const maxMs = options.retry.backoff?.maxMs ?? 30000;
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(baseMs * Math.pow(2, attempt), maxMs)));
            attempt += 1;
          }
        }
      })().finally(() => {
        if (flights.get(key) === flight) flights.delete(key);
      });
      flights.set(key, flight);
      return flight;
    },
    invalidate: clearEntry,
    noteRowsLost: clearEntry,
    reset
  };
};
