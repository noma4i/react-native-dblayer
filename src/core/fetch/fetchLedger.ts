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
  /** Opaque composite row identities from the latest applied result. */
  ids: Set<string>;
};

type FetchEntrySnapshot = Omit<FetchEntry, 'ids'>;

type RunOutcome = { applied: true; count: number; ids: readonly string[]; cursor?: string | null } | { applied: false };

type RunStatus = 'applied' | 'skipped' | 'offline' | 'failed';

type RunContext = {
  /** Cursor recorded by the previous applied page of this chain; null starts a new chain. */
  cursor: string | null;
  attempt: number;
  /** False once the runtime generation moved on; the caller must not apply anything when false. */
  isCurrent: () => boolean;
};

type ActiveRefetch = {
  /** Drop the entry's freshness when this reader is a foreground-resume candidate. */
  markResumeStale(): boolean;
  /** Start a refetch after the coordinator has selected this reader's chunk. */
  refetch(): Promise<void>;
};

type FetchLedger = {
  read(key: FetchKey): Readonly<FetchEntrySnapshot> | undefined;
  /** True when `lastAppliedAt` is within `staleTimeMs` of `now()`. False when never applied. */
  isFresh(key: FetchKey, staleTimeMs: number): boolean;
  /** Single-flight per key, retry policy, offline gate; stamps only on applied-while-current. */
  run(key: FetchKey, execute: (ctx: RunContext) => Promise<RunOutcome>): Promise<RunStatus>;
  /** Drop freshness so the next read refetches. */
  invalidate(key: FetchKey): void;
  /** Internal coordinator bridge to refetch every active reader for one key. */
  refetchKey(key: FetchKey): Promise<void>;
  /** Internal coordinator bridge to refetch active readers whose freshness was dropped. */
  refetchStaleReaders(): Promise<void>;
  /** Drop freshness only after every committed identity behind a key was destroyed, evicted, or trimmed. */
  noteRowsLost(ids: readonly string[]): void;
  /** Register a live reader and its foreground-resume policy; returns the release callback. */
  retain(key: FetchKey, refetch: () => Promise<void>, markResumeStale?: () => boolean): () => void;
  /** Keys with at least one live reader, in registration order. */
  activeKeys(): FetchKey[];
  /** Internal coordinator bridge for globally chunked foreground resume. */
  activeRefetches(): ActiveRefetch[];
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
  const readers = new Map<FetchKey, Map<number, ActiveRefetch>>();
  const generations = new Map<FetchKey, number>();
  let nextReaderId = 0;

  const clearEntry = (key: FetchKey): void => {
    const entry = entries.get(key);
    if (!entry || (entry.lastAppliedAt === null && entry.lastCount === null && entry.cursor === null && entry.pages === 0)) return;
    entries.set(key, { lastAppliedAt: null, lastCount: null, cursor: null, pages: 0, ids: new Set() });
    options.onStamp(key);
  };

  const invalidate = (key: FetchKey): void => {
    generations.set(key, (generations.get(key) ?? 0) + 1);
    flights.delete(key);
    clearEntry(key);
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

  const activeRefetches = (): ActiveRefetch[] => activeKeys().flatMap(key => [...(readers.get(key)?.values() ?? [])]);
  const refetchKey = async (key: FetchKey): Promise<void> => {
    await Promise.all([...(readers.get(key)?.values() ?? [])].map(reader => reader.refetch().catch(() => {})));
  };

  const reset = (): void => {
    entries.clear();
    flights.clear();
    readers.clear();
    generations.clear();
  };

  registerReset(reset);

  return {
    read: key => {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const { ids: _ids, ...snapshot } = entry;
      return snapshot;
    },
    isFresh: (key, staleTimeMs) => {
      const lastAppliedAt = entries.get(key)?.lastAppliedAt;
      return lastAppliedAt !== undefined && lastAppliedAt !== null && options.now() - lastAppliedAt <= staleTimeMs;
    },
    run: (key, execute) => {
      const existing = flights.get(key);
      if (existing) return existing;
      if (!options.isOnline()) return Promise.resolve('offline');

      const generationFence = createGenerationFence();
      const keyGeneration = generations.get(key) ?? 0;
      const cursor = entries.get(key)?.cursor ?? null;
      const flight = (async (): Promise<RunStatus> => {
        let attempt = 1;
        while (true) {
          try {
            const isCurrent = (): boolean => generationFence.isCurrent() && (generations.get(key) ?? 0) === keyGeneration;
            const outcome = await execute({ cursor, attempt, isCurrent });
            if (!outcome.applied || !isCurrent()) return 'skipped';

            const previous = entries.get(key);
            const hasCursor = 'cursor' in outcome;
            const next = {
              lastAppliedAt: options.now(),
              lastCount: outcome.count,
              cursor: hasCursor ? outcome.cursor ?? null : null,
              pages: hasCursor ? (cursor === null ? 1 : (previous?.pages ?? 0) + 1) : 1,
              ids: new Set(outcome.ids)
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
            if (!options.isOnline()) return 'offline';
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
    invalidate,
    refetchKey,
    refetchStaleReaders: async () => {
      await Promise.all([...entries].filter(([, entry]) => entry.lastAppliedAt === null).map(([key]) => refetchKey(key)));
    },
    noteRowsLost: lostIds => {
      if (lostIds.length === 0) return;
      const lost = new Set(lostIds);
      for (const [key, entry] of entries) {
        if (entry.ids.size === 0) continue;
        for (const id of lost) entry.ids.delete(id);
        if (entry.ids.size === 0) {
          clearEntry(key);
        }
      }
    },
    retain: (key, refetch, markResumeStale = () => false) => {
      const keyReaders = readers.get(key) ?? new Map<number, ActiveRefetch>();
      readers.set(key, keyReaders);
      const readerId = nextReaderId;
      nextReaderId += 1;
      keyReaders.set(readerId, { refetch, markResumeStale });
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
    activeRefetches,
    resume: async chunkSize => {
      const refetches = activeRefetches();
      for (let index = 0; index < refetches.length; index += chunkSize) {
        const chunk = refetches.slice(index, index + chunkSize);
        await Promise.all(chunk.map(reader => Promise.resolve().then(reader.refetch).catch(() => {})));
      }
    },
    reset
  };
};
