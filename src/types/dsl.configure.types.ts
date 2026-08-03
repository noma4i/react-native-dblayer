import type { DbLogger, DbRetryPolicy, DbTransport } from './db.types';
import type { StoragePlane } from './core.planes.storagePlane.types';

export interface DbDefaults {
  /** Package-wide default `staleTime` (ms) for `defineQuery` results that omit their own. */
  staleTime?: number;
  /** Named freshness vocabulary: `staleTime: '<name>'` on a query/fetch resolves through this map. An unknown name throws at resolution, a non-positive/non-finite value throws at `configureDb`. */
  freshnessClasses?: Readonly<Record<string, number>>;
  /** Package-wide default `emptyStaleTime` (ms) for remote relation results that omit their own. */
  emptyStaleTime?: number;
  /** Package-wide default window size for `ScopeHandle.useWindow` when its own `pageSize` is omitted. */
  pageSize?: number;
  /** Retry policies for query and mutation work. Missing classifiers disable retries. */
  retry?: { query?: DbRetryPolicy; mutation?: DbRetryPolicy };
  /** Whether stale queries refetch when their consumer mounts. Defaults to true. */
  refetchOnMount?: boolean;
  /**
   * Foreground-resume freshness window (ms). When the app returns to the active AppState, every db
   * query whose data is older than this window is invalidated (active hooks refetch immediately,
   * inactive cache entries refetch on next mount). `null` disables resume invalidation. Default 60000.
   */
  resumeStaleTime?: number | null;
  /** Foreground-resume refetch pacing. Mounted db queries invalidated on resume refetch in sequential chunks of chunkSize (default 4) awaited one after another, instead of one synchronous burst. Unmounted cache entries are only marked stale and refetch on next mount. */
  resumeRefetch?: { chunkSize?: number };
  /** Checkpoint flush tuning: snapshots leave the hot path and batch here. */
  persistence?: { checkpointDelayMs?: number; maxPendingPlans?: number };
  /** Observes contained pipeline failures from `query`, `mutation`, and `ingest` without changing their control flow. */
  onSyncError?: (error: Error, ctx: { source: string; model?: string; scope?: unknown; key?: string; event?: string }) => void;
}

export type ConfigureDbOptions = {
  transport: DbTransport;
  storage?: StoragePlane;
  logger?: DbLogger;
  defaults?: DbDefaults;
  /** Consumer-owned cache version (e.g. the app build number). Changing it cold-resets the whole persisted library state at boot - stale data can never layer across versions. */
  dataVersion?: string;
};

/** Resolved runtime configuration after `configureDb` defaults are applied. */
export type RuntimeConfig = Omit<ConfigureDbOptions, 'storage' | 'defaults' | 'dataVersion'> & {
  storage: StoragePlane;
  defaults: DbDefaults & { resumeStaleTime: number | null };
  dataVersion: string | null;
};
