import type { DbLogger, DbRetryPolicy, DbTransport } from './db.types';
import type { StoragePlane } from './core.planes.storagePlane.types';

export interface DbDefaults {
  /** Package-wide default `staleTime` (ms) for `defineQuery` results that omit their own. */
  staleTime?: number;
  /** Package-wide default `emptyStaleTime` (ms) for `defineQuery` and `defineFetch` results that omit their own. */
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
  /** Foreground-resume refetch pacing. Active db queries invalidated on resume refetch in sequential chunks of chunkSize (default 4) awaited one after another, instead of one synchronous burst. Inactive cache entries are only marked stale and refetch on next mount. */
  resumeRefetch?: { chunkSize?: number };
  /** Checkpoint flush tuning: snapshots leave the hot path and batch here. */
  persistence?: { checkpointDelayMs?: number; maxPendingPlans?: number };
  /**
   * In-session garbage-collection trigger tuning. ON by default (`threshold: 500`,
   * `debounceMs: 1000`) - a burst of destroys/inserts crossing the pressure threshold schedules one
   * debounced `collectGarbage()` sweep. Set `false` to disable the trigger entirely; `bootDb`'s
   * startup sweep and manual `collectGarbage()` calls are unaffected either way.
   */
  inSessionGc?: false | { threshold?: number; debounceMs?: number };
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
