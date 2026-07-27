import type { DbRetryPolicy } from '../../types';
import { registerReset } from '../reset';
import { createGenerationFence } from '../../utils/runtimeGeneration';

type FetchKey = string;

type FetchEntry = {
  /** Epoch ms of the last outcome successfully applied to the store; null if never. */
  lastAppliedAt: number | null;
  /** Size of the last applied result; 0 is meaningful, null means never applied. */
  lastCount: number | null;
  /** Cursor for the next page of the current chain; null when complete or unused. */
  cursor: string | null;
  /** Pages applied in the current chain. */
  pages: number;
};

type RunOutcome = { applied: true; count: number; cursor?: string | null } | { applied: false };

type RunStatus = 'applied' | 'skipped' | 'offline' | 'failed';

type RunContext = {
  /** Cursor recorded by the previous applied page of this chain; null starts a new chain. */
  cursor: string | null;
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
  /** Register a live reader and how to refetch it; returns the release callback. */
  retain(key: FetchKey, refetch: () => Promise<void>): () => void;
  /** Keys with at least one live reader, in registration order. */
  activeKeys(): FetchKey[];
  /** Walk `activeKeys()` in chunks of `chunkSize`, awaiting each chunk's refetches. */
  resume(chunkSize: number): Promise<void>;
  reset(): void;
};

/** Create a key-scoped freshness ledger for injected fetch work. */
export const createFetchLedger = (options: {
  now: () => number;
  retry: DbRetryPolicy;
  isOnline: () => boolean;
  /** Called whenever an entry's freshness changes. */
  onStamp: (key: FetchKey) => void;
  /** Maximum retained entries without live readers. */
  maxEntries: number;
}): FetchLedger => {
  const entries = new Map<FetchKey, FetchEntry>();
  const flights = new Map<FetchKey, Promise<RunStatus>>();
  const readers = new Map<FetchKey, Map<number, () => Promise<void>>>();
  let nextReaderId = 0;

  const clearEntry = (key: FetchKey): void => {
    const entry = entries.get(key);
    if (!entry || (entry.lastAppliedAt === null && entry.lastCount === null && entry.cursor === null && entry.pages === 0)) return;
    entries.set(key, { lastAppliedAt: null, lastCount: null, cursor: null, pages: 0 });
    options.onStamp(key);
  };

  const trimEntries = (): void => {
    while (entries.size > options.maxEntries) {
      let evictedKey: FetchKey | undefined;
      let oldestStamp = Infinity;
      for (const [key, entry] of entries) {
        if (readers.has(key)) continue;
        const stamp = entry.lastAppliedAt ?? -Infinity;
        if (stamp < oldestStamp) {
          evictedKey = key;
          oldestStamp = stamp;
        }
      }
      if (evictedKey === undefined) return;
      entries.delete(evictedKey);
      options.onStamp(evictedKey);
    }
  };

  const activeKeys = (): FetchKey[] => [...readers.keys()];

  const reset = (): void => {
    entries.clear();
    flights.clear();
    readers.clear();
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
      const cursor = entries.get(key)?.cursor ?? null;
      const flight = (async (): Promise<RunStatus> => {
        let attempt = 1;
        while (true) {
          try {
            const outcome = await execute({ cursor, attempt, isCurrent: generationFence.isCurrent });
            if (!outcome.applied || !generationFence.isCurrent()) return 'skipped';

            const previous = entries.get(key);
            const hasCursor = 'cursor' in outcome;
            const next = {
              lastAppliedAt: options.now(),
              lastCount: outcome.count,
              cursor: hasCursor ? outcome.cursor ?? null : null,
              pages: hasCursor ? (cursor === null ? 1 : (previous?.pages ?? 0) + 1) : 1
            };
            entries.set(key, next);
            if (
              previous?.lastAppliedAt !== next.lastAppliedAt ||
              previous.lastCount !== next.lastCount ||
              previous.cursor !== next.cursor ||
              previous.pages !== next.pages
            ) options.onStamp(key);
            trimEntries();
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
    retain: (key, refetch) => {
      const keyReaders = readers.get(key) ?? new Map<number, () => Promise<void>>();
      readers.set(key, keyReaders);
      const readerId = nextReaderId;
      nextReaderId += 1;
      keyReaders.set(readerId, refetch);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const currentReaders = readers.get(key);
        if (!currentReaders?.delete(readerId)) return;
        if (currentReaders.size === 0) readers.delete(key);
      };
    },
    activeKeys,
    resume: async chunkSize => {
      const keys = activeKeys();
      for (let index = 0; index < keys.length; index += chunkSize) {
        const refetches = keys.slice(index, index + chunkSize).flatMap(key => [...(readers.get(key)?.values() ?? [])]);
        await Promise.all(refetches.map(refetch => Promise.resolve().then(refetch).catch(() => {})));
      }
    },
    reset
  };
};
