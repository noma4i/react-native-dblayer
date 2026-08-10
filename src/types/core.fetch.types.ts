import type { QueryKey } from '@tanstack/react-query';

/** One mounted query/fetch reader registered for loss-driven refetch and foreground resume. */
export type ActiveFetchReader = {
  queryKey: QueryKey;
  /** Drop the reader's freshness when it is a foreground-resume candidate. */
  markResumeStale(): boolean;
  /** Refetch after the coordinator selected this reader's resume chunk. */
  refetch(): Promise<void>;
};

/**
 * One query registered for committed materialization loss. Freshness is only valid while the applied
 * result is still materialized: ids whose row was destroyed, and ids whose row survived but left the
 * destination scope, are both pruned from the chain, and a chain that keeps nothing goes stale.
 */
export type MaterializationReconciler = {
  modelId: string;
  /** Every registered chain of this query, each able to report what its destination still materializes. */
  chains(): Iterable<MaterializedChain>;
};

/**
 * One registered scope of a query: its cache key, the destination scope it depends on (`null` for a
 * model destination, which depends on row presence alone) and the composite row ids still held.
 */
export type MaterializedChain = {
  queryKey: QueryKey;
  scopeKey: string | null;
  materialized(candidates: readonly string[]): ReadonlySet<string>;
  /** Persist the same reconciled ids and freshness state that the query cache receives. */
  persistMaterialization(ids: readonly string[]): void;
};

/** Query-invalidation callback registered per model. */
export type InvalidateFn = (scope?: unknown) => boolean;

/**
 * Per-key reader-local state react-query's vocabulary cannot express (offline pause, next-page
 * distinction): flags, a monotonic change version, and listener fan-out - one home shared by
 * remote relation queries.
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
