import type { QueryKey } from '@tanstack/react-query';

/** One mounted query/fetch reader registered for loss-driven refetch and foreground resume. */
export type ActiveFetchReader = {
  queryKey: QueryKey;
  /** Drop the reader's freshness when it is a foreground-resume candidate. */
  markResumeStale(): boolean;
  /** Refetch after the coordinator selected this reader's resume chunk. */
  refetch(): Promise<void>;
};

/** Query-invalidation callback registered per model. */
export type InvalidateFn = (scope?: unknown) => void;

/**
 * Per-key reader-local state react-query's vocabulary cannot express (offline pause, next-page
 * distinction): flags, a monotonic change version, and listener fan-out - one home shared by
 * `defineQuery` and `defineFetch`.
 */
export type KeyedLocalState<TState> = {
  get(key: string): TState;
  /** Merge a partial state; no-op (no version bump, no notify) when nothing changed. */
  set(key: string, next: Partial<TState>): void;
  subscribe(key: string, listener: () => void): () => void;
  /** Monotonic per-key change counter for snapshot signatures. */
  version(key: string): number;
  clear(): void;
};
