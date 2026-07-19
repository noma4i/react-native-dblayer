import { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTransport } from '../types';
import { mmkvStoragePlane, type StoragePlane } from '../core/planes/storagePlane';
import { setDbLogger } from '../core/logger';
import { setDbTransport } from '../core/transport';
import { createCommitBus } from '../core/apply/commitBus';
import { createCheckpointScheduler, type CheckpointScheduler } from '../core/apply/checkpoint';
import { createApplyRuntime, getApplyTarget, type ApplyRuntime } from '../core/apply/transaction';
import { createOperationState, type OperationState } from '../core/planes/operationState';
import { expandPlan } from '../core/relations';
import { isTempId } from '../utils/generateTempId';
import { registerReset } from '../core/reset';
import { resetCollectionRegistry } from '../core/tanstack/facade';
import { seedCollections, startCollectionMirror } from '../core/tanstack/mirror';
import { startMaintenanceScheduler } from '../core/maintenanceScheduler';

export type DbRetryClass = 'network' | 'server' | 'retriable' | 'fatal';

export type DbRetryPolicy = {
  /** Classify one failure before its retry budget is consulted. Omit for no retries. */
  classify?: (error: unknown) => DbRetryClass;
  /** Maximum retry attempts for each non-fatal class. Defaults to zero. */
  budgets?: Partial<Record<Exclude<DbRetryClass, 'fatal'>, number>>;
  /** Exponential retry delay bounds in milliseconds. Defaults to 1000 and 30000. */
  backoff?: { baseMs: number; maxMs: number };
};

export interface DbDefaults {
  /** Package-wide default `staleTime` (ms) for `defineQuery` results that omit their own. */
  staleTime?: number;
  /** Package-wide default `emptyStaleTime` (ms) for `defineQuery` and `defineFetch` results that omit their own. */
  emptyStaleTime?: number;
  /** Package-wide default TanStack Query cache `gcTime` (ms) for `defineQuery` results that omit their own. */
  gcTime?: number;
  /** Package-wide default window size for `ScopeHandle.useWindow` when its own `pageSize` is omitted. */
  pageSize?: number;
  /** Retry policies for query and mutation work. Missing classifiers disable retries. */
  retry?: { query?: DbRetryPolicy; mutation?: DbRetryPolicy };
  /** Network behavior for internally owned query and mutation work. Defaults to `offlineFirst`. */
  networkMode?: 'offlineFirst' | 'online';
  /** Whether queries refetch after network reconnection. Defaults to true. */
  refetchOnReconnect?: boolean;
  /** Whether stale queries refetch when their consumer mounts. Defaults to true. */
  refetchOnMount?: boolean;
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

export type ConfigureDbOptions = { transport: DbTransport; storage?: StoragePlane; logger?: DbLogger; defaults?: DbDefaults };
type RuntimeConfig = Omit<ConfigureDbOptions, 'storage'> & { storage: StoragePlane; queryClient: QueryClient };
let runtimeConfig: RuntimeConfig | null = null;
let applyRuntime: ApplyRuntime | null = null;
let operationState: OperationState | null = null;
let checkpointScheduler: CheckpointScheduler | null = null;
let runtimeGeneration = 0;
let replayCompleted = false;
const commitBus = createCommitBus();
let stopCollectionMirror: (() => void) | null = null;
let collectionRegistryResetRegistered = false;
let stopMaintenanceScheduler: (() => void) | null = null;
let maintenanceSchedulerResetRegistered = false;
let queryClientResetRegistered = false;

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/**
 * Configure the injected runtime seams (transport, storage, logger) and package-wide
 * defaults. Must be called once before any model, query, or mutation runs; calling it again advances the
 * runtime generation, discards cached apply/operation runtimes, and re-applies transport/logger.
 *
 * Call this before rendering `DbProvider`; the provider owns the subsequent `bootDb` data lifecycle.
 *
 * @param options.transport GraphQL transport (`query`/`mutation`) used by `defineQuery`/`defineMutation`.
 * @param options.storage Synchronous key/value seam for persistence; defaults to `mmkvStoragePlane()`.
 * @param options.logger Package logger seam; optional, defaults to the built-in logger.
 * @param options.defaults Package-wide freshness/pagination/error-observation defaults (see `DbDefaults`).
 */
export const configureDb = (options: ConfigureDbOptions): void => {
  runtimeConfig?.queryClient.clear();
  runtimeGeneration += 1;
  replayCompleted = false;
  const defaults = options.defaults;
  const retryOptions = (policy: DbRetryPolicy | undefined) => ({
    retry: policy?.classify
      ? (failureCount: number, error: unknown) => {
          const classification = policy.classify?.(error) ?? 'fatal';
          if (classification === 'fatal') return false;
          return failureCount < (policy.budgets?.[classification] ?? 0);
        }
      : false,
    retryDelay: (attempt: number) => {
      const baseMs = policy?.backoff?.baseMs ?? 1000;
      const maxMs = policy?.backoff?.maxMs ?? 30000;
      return Math.min(baseMs * Math.pow(2, attempt), maxMs);
    }
  });
  const networkMode = defaults?.networkMode ?? 'offlineFirst';
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        ...retryOptions(defaults?.retry?.query),
        networkMode,
        refetchOnReconnect: defaults?.refetchOnReconnect ?? true,
        refetchOnMount: defaults?.refetchOnMount ?? true,
        refetchOnWindowFocus: false
      },
      mutations: { ...retryOptions(defaults?.retry?.mutation), networkMode }
    }
  });
  runtimeConfig = { ...options, storage: options.storage ?? mmkvStoragePlane(), queryClient };
  applyRuntime = null;
  operationState = null;
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
  if (!queryClientResetRegistered) {
    registerReset(() => runtimeConfig?.queryClient.clear());
    queryClientResetRegistered = true;
  }
  getApplyRuntime();
  stopCollectionMirror?.();
  resetCollectionRegistry();
  stopCollectionMirror = startCollectionMirror(commitBus);
  if (!collectionRegistryResetRegistered) {
    registerReset(resetCollectionRegistry);
    collectionRegistryResetRegistered = true;
  }
  stopMaintenanceScheduler?.();
  stopMaintenanceScheduler = options.defaults?.inSessionGc === false ? null : startMaintenanceScheduler(options.defaults?.inSessionGc);
  if (!maintenanceSchedulerResetRegistered) {
    registerReset(() => {
      stopMaintenanceScheduler?.();
      stopMaintenanceScheduler = null;
    });
    maintenanceSchedulerResetRegistered = true;
  }
};

export const getDbRuntimeConfig = (): RuntimeConfig => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
export const isDbConfigured = (): boolean => runtimeConfig !== null;

/** Internal: reports whether the current runtime completed journal replay. */
export const hasReplayedJournal = (): boolean => replayCompleted;

export const getStoragePrefix = (): string => STORAGE_PREFIX;

/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export const getRuntimeGeneration = (): number => runtimeGeneration;

/** Internal: establish a new generation before the reset fence tears down the old runtime. */
export const advanceRuntimeGeneration = (): void => {
  runtimeGeneration += 1;
};

export const getCommitBus = () => commitBus;

/** Internal: return the library-owned QueryClient for provider and query modules. */
export const getInternalQueryClient = (): QueryClient => getDbRuntimeConfig().queryClient;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 * Persistence is WAL + checkpoint: plans write only their journal record; model snapshots flush
 * through the checkpoint scheduler off the hot path.
 */
export const getApplyRuntime = (): ApplyRuntime => {
  if (!applyRuntime) {
    const { storage, defaults } = getDbRuntimeConfig();
    checkpointScheduler = createCheckpointScheduler({
      storage,
      prefix: getStoragePrefix,
      getTarget: getApplyTarget,
      delayMs: defaults?.persistence?.checkpointDelayMs ?? 500,
      maxPendingPlans: defaults?.persistence?.maxPendingPlans ?? 25,
      extraEntries: () => {
        const operations = getOperationState();
        operations.prune();
        return operations.persistEntries();
      }
    });
    applyRuntime = createApplyRuntime({ storage, prefix: getStoragePrefix, bus: commitBus, checkpoint: checkpointScheduler });
  }
  return applyRuntime;
};

/**
 * Force a checkpoint flush NOW - pending model snapshots hit storage in one batch. The host app
 * must call this on background/inactive and before logout teardown. `suspendDb()` calls this for you
 * as part of the recommended background/teardown sequence.
 */
export const flushPersistence = (): void => {
  checkpointScheduler?.flushNow();
};

/** Persist plane mutations made by maintenance outside an apply-plan epoch. */
export const noteMaintenancePersistence = (models: ReadonlyArray<string>): void => {
  getApplyRuntime();
  checkpointScheduler?.noteMaintenance(models);
};

/**
 * Idempotently re-apply journal records not yet covered by each model's persisted applied-epoch
 * marker. The host app must call this ONCE at startup, after configureDb and after every model
 * module has been imported (apply targets registered) - records touching unregistered models throw.
 * Returns the number of replayed records.
 *
 * `bootDb` calls this before garbage collection and foreign-key cleanup and surfaces the result as
 * `{ replayed }`.
 *
 * @returns The number of journal records replayed.
 */
export const replayJournal = (): number => {
  const runtime = getApplyRuntime();
  const storage = getDbRuntimeConfig().storage;
  const rowPrefix = `${getStoragePrefix()}row:`;
  const models = new Set<string>();
  for (const key of storage.keys(rowPrefix)) {
    const model = key.slice(rowPrefix.length).split(':', 1)[0];
    if (model) models.add(model);
  }
  seedCollections([...models]);
  const replayed = runtime.replay();
  const operations = getOperationState();
  const hasApplyTarget = (model: string): boolean => {
    try {
      getApplyTarget(model);
      return true;
    } catch {
      return false;
    }
  };
  const orphaned = operations.hydratedPending();
  for (const operation of orphaned) {
    if (operation.tempIds.length > 0 && hasApplyTarget(operation.model)) {
      runtime.apply(expandPlan([{ kind: 'destroy', model: operation.model, ids: operation.tempIds, tombstone: false }]));
    }
    operations.close(operation.operationId, 'rolledback');
  }
  const candidates = new Map<string, Set<string>>();
  const noteCandidate = (model: string, id: unknown): void => {
    if (typeof id !== 'string' || !isTempId(id)) return;
    const ids = candidates.get(model) ?? new Set<string>();
    ids.add(id);
    candidates.set(model, ids);
  };
  for (const key of storage.keys(rowPrefix)) {
    const [model, id] = key.slice(rowPrefix.length).split(':', 2);
    if (model && id) noteCandidate(model, id);
  }
  for (const key of storage.keys(`${getStoragePrefix()}journal:`)) {
    const raw = storage.get(key);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as { ops?: Array<{ kind?: string; model?: string; rows?: Array<{ id?: unknown }> }> };
      for (const operation of record.ops ?? []) {
        if (operation.kind !== 'upsert' || !operation.model) continue;
        for (const row of operation.rows ?? []) noteCandidate(operation.model, row.id);
      }
    } catch {}
  }
  const pendingTempIds = new Set(operations.pending().flatMap(operation => operation.tempIds));
  for (const [model, ids] of candidates) {
    const orphanIds = [...ids].filter(id => !pendingTempIds.has(id));
    if (orphanIds.length > 0 && hasApplyTarget(model)) runtime.apply(expandPlan([{ kind: 'destroy', model, ids: orphanIds, tombstone: false }]));
  }
  flushPersistence();
  replayCompleted = true;
  return replayed;
};

/**
 * Remove storage keys outside the library namespace during startup housekeeping for the dedicated
 * storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb(options)` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
export const purgeForeignStorageKeys = (): number => {
  const { storage } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  if (foreign.length > 0) storage.set(foreign.map(key => ({ key, value: null })));
  return foreign.length;
};

/** Internal: kill-switch discards pending snapshots (storage is being wiped anyway). */
export const cancelPersistence = (): void => {
  checkpointScheduler?.cancel();
};

/** Internal: discard per-runtime WAL/checkpoint caches after storage has been wiped. */
export const resetPersistenceRuntime = (): void => {
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  applyRuntime = null;
  operationState = null;
};

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export const getOperationState = (): OperationState => {
  if (!operationState) {
    const { storage } = getDbRuntimeConfig();
    operationState = createOperationState({
      storage,
      prefix: getStoragePrefix,
      now: () => Date.now(),
      notify: operation => {
        const rowIds = operation.rowIds ?? operation.tempIds;
        if (operation.model === '' || rowIds.length === 0) return;
        commitBus.publish({ rows: [], scopes: [], pending: rowIds.map(id => ({ model: operation.model, id })) });
      }
    });
    operationState.hydrate();
  }
  return operationState;
};
