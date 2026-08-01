import { QueryClient } from '@tanstack/react-query';
import type { ApplyRuntime, CheckpointScheduler, CommitBus, ConfigureDbOptions, OperationState, OperationTransition, RuntimeConfig, WriteOp } from '../types';
import { retryDelayMs } from '../core/fetch/retryPolicy';
import { isFetchNetworkOnline } from '../core/fetch/networkState';
import { mmkvStoragePlane } from '../core/planes/storagePlane';
import { setDbLogger } from '../core/logger';
import { setDbTransport } from '../core/transport';
import { createCommitBus } from '../core/apply/commitBus';
import { createCheckpointScheduler } from '../core/apply/checkpoint';
import { getApplyTarget } from '../core/apply/applyTargetRegistry';
import { createCommitEnvelope } from '../core/apply/commitEnvelope';
import { createApplyRuntime } from '../core/apply/transaction';
import { readJournalRecord } from '../core/apply/journal';
import { createOperationState } from '../core/planes/operationState';
import { isTempId } from '../utils/generateTempId';
import { registerReset, resetInMemoryRuntime } from '../core/reset';
import { registerResidency } from '../core/residency';
import { isTempRowProtectedByModel } from './maintenanceRegistry';
import { resetStores } from '../core/store';
import { compositeKey, compositeStorageKey, parseCompositeKey } from '../core/serialize';
import { advanceRuntimeGeneration, getRuntimeGeneration } from '../utils/runtimeGeneration';

let runtimeConfig: RuntimeConfig | null = null;
let applyRuntime: ApplyRuntime | null = null;
let operationState: OperationState | null = null;
let checkpointScheduler: CheckpointScheduler | null = null;
let queryClient: QueryClient | null = null;
const commitBus = createCommitBus();
let storeResetRegistered = false;
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
  advanceRuntimeGeneration();
  resetInMemoryRuntime();
  const declaredChunkSize = options.defaults?.resumeRefetch?.chunkSize;
  if (declaredChunkSize !== undefined && (!Number.isInteger(declaredChunkSize) || declaredChunkSize <= 0)) {
    throw new Error(`react-native-dblayer: defaults.resumeRefetch.chunkSize must be a positive integer, received ${declaredChunkSize}`);
  }
  const defaults = { ...options.defaults, resumeStaleTime: options.defaults?.resumeStaleTime === undefined ? 60_000 : options.defaults.resumeStaleTime };
  runtimeConfig = { ...options, defaults, storage: options.storage ?? mmkvStoragePlane(), dataVersion: options.dataVersion ?? null };
  applyRuntime = null;
  operationState = null;
  queryClient = null; // Orphan, never clear(): cancelling in-flight fetches rejects their retryer promises as unhandled CancelledErrors.
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
  getApplyRuntime();
  if (!storeResetRegistered) {
    registerReset(resetStores);
    storeResetRegistered = true;
  }
};

export const getDbRuntimeConfig = (): RuntimeConfig => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

/**
 * Internal: the package-owned TanStack QueryClient behind every `defineQuery`/`defineFetch`
 * freshness decision. Never exposed to consumers - the library stays the only QueryClient owner.
 * Query retry policy maps our `DbRetryPolicy` formula onto react-query's retry/retryDelay pair;
 * `networkMode: 'always'` keeps react-query out of connectivity decisions - the coordinator's own
 * network gate (`setFetchNetworkOnline`) pauses fetch paths and subscription retries while offline.
 */
export const getDbQueryClient = (): QueryClient => {
  if (queryClient) return queryClient;
  if (!queryClientResetRegistered) {
    registerReset(() => {
      queryClient = null; // Orphaned with its generation; see configureDb.
    });
    queryClientResetRegistered = true;
  }
  const generation = getRuntimeGeneration();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'always',
        staleTime: 0,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
        retry: (failureCount, error) =>
          getRuntimeGeneration() === generation &&
          isFetchNetworkOnline() &&
          retryDelayMs(getDbRuntimeConfig().defaults.retry?.query ?? {}, error, failureCount + 1) !== null,
        retryDelay: (failureCount, error) =>
          getRuntimeGeneration() === generation ? (retryDelayMs(getDbRuntimeConfig().defaults.retry?.query ?? {}, error, failureCount) ?? 0) : 0
      }
    }
  });
  return queryClient;
};

/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
export const isDbConfigured = (): boolean => runtimeConfig !== null;

export const getStoragePrefix = (): string => STORAGE_PREFIX;

/** Internal: consumer-owned cache version used by the persistence manifest compatibility gate. */
export const getPersistenceDataVersion = (): string | null => getDbRuntimeConfig().dataVersion;

export { advanceRuntimeGeneration, getRuntimeGeneration };

export const getCommitBus = (): CommitBus => commitBus;

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
 * `bootDb` calls this before foreign-key cleanup and surfaces the result as
 * `{ replayed }`.
 *
 * @returns The number of journal records replayed.
 */
export const replayJournal = (): number => {
  const runtime = getApplyRuntime();
  const storage = getDbRuntimeConfig().storage;
  const rowPrefix = compositeStorageKey(getStoragePrefix(), 'row');
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
  const orphaned = operations.takeHydratedPending(operation => operation.kind === undefined);
  if (orphaned.length > 0) {
    const orphanDestroyOps: WriteOp[] = [];
    const orphanTransitions: OperationTransition[] = [];
    for (const operation of orphaned) {
      if (operation.tempIds.length > 0 && hasApplyTarget(operation.model)) {
        orphanDestroyOps.push({ kind: 'destroy', model: operation.model, ids: operation.tempIds, tombstone: false });
      }
      orphanTransitions.push({ kind: 'close' as const, operationId: operation.operationId, status: 'rolledback' as const });
    }
    runtime.commit(createCommitEnvelope(orphanDestroyOps, orphanTransitions));
  }
  const candidates = new Map<string, Set<string>>();
  const noteCandidate = (model: string, id: unknown): void => {
    if (typeof id !== 'string' || !isTempId(id)) return;
    const ids = candidates.get(model) ?? new Set<string>();
    ids.add(id);
    candidates.set(model, ids);
  };
  for (const key of storage.keys(rowPrefix)) {
    const parts = parseCompositeKey(key.slice(rowPrefix.length));
    if (parts?.length === 2) noteCandidate(parts[0]!, parts[1]);
  }
  for (const key of storage.keys(`${getStoragePrefix()}journal:`)) {
    const record = readJournalRecord(storage, getStoragePrefix(), key);
    for (const operation of record?.ops ?? []) {
      if (operation.kind !== 'upsert') continue;
      for (const row of operation.rows) noteCandidate(operation.model, row.id);
    }
  }
  const openTempIds = new Set(operations.open().flatMap(operation => operation.tempIds.map(id => compositeKey(operation.model, id))));
  for (const [model, ids] of candidates) {
    const orphanIds = [...ids].filter(id => !openTempIds.has(compositeKey(model, id)) && !operations.failedFor(model, id) && !isTempRowProtectedByModel(model, id));
    if (orphanIds.length > 0 && hasApplyTarget(model)) runtime.commit(createCommitEnvelope([{ kind: 'destroy', model, ids: orphanIds, tombstone: false }]));
  }
  flushPersistence();
  return replayed;
};

/**
 * Remove storage keys outside the library namespace during startup housekeeping for the dedicated
 * storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb()` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
export const purgeForeignStorageKeys = (): number => {
  const { storage } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  if (foreign.length > 0) storage.set(foreign.map(key => ({ key, value: null })));
  return foreign.length;
};

/** Internal: discard per-runtime WAL/checkpoint caches after storage has been wiped. */
export const resetPersistenceRuntime = (): void => {
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  applyRuntime = null;
  operationState = null;
};

registerResidency('operationRowBuckets', () => operationState?.residentRowBuckets() ?? 0);

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
