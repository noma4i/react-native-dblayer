import type { QueryClient } from '@tanstack/react-query';
import type { DbLogger, DbTransport } from '../types';
import { mmkvStoragePlane, type StoragePlane } from '../core/planes/storagePlane';
import { setDbLogger } from '../core/logger';
import { setDbTransport } from '../core/transport';
import { createCommitBus } from '../core/apply/commitBus';
import { createCheckpointScheduler, type CheckpointScheduler } from '../core/apply/checkpoint';
import { createApplyRuntime, getApplyTarget, type ApplyRuntime } from '../core/apply/transaction';
import { createOperationState, type OperationState } from '../core/planes/operationState';

export interface DbDefaults {
  staleTime?: number;
  emptyStaleTime?: number;
  gcTime?: number;
  pageSize?: number;
  /** Checkpoint flush tuning: snapshots leave the hot path and batch here. */
  persistence?: { checkpointDelayMs?: number; maxPendingPlans?: number };
  onSyncError?: (error: Error, ctx: { source: string; model?: string; scope?: unknown }) => void;
}

type RuntimeConfig = { transport: DbTransport; storage: StoragePlane; queryClient?: QueryClient; logger?: DbLogger; defaults?: DbDefaults };
let runtimeConfig: RuntimeConfig | null = null;
let applyRuntime: ApplyRuntime | null = null;
let operationState: OperationState | null = null;
let checkpointScheduler: CheckpointScheduler | null = null;
const commitBus = createCommitBus();

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
export const configureDb = (options: Omit<RuntimeConfig, 'storage'> & { storage?: StoragePlane }): void => {
  runtimeConfig = { ...options, storage: options.storage ?? mmkvStoragePlane() };
  applyRuntime = null;
  operationState = null;
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
};

export const getDbRuntimeConfig = (): RuntimeConfig => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

export const getStoragePrefix = (): string => STORAGE_PREFIX;

export const getCommitBus = () => commitBus;

/** App-owned TanStack QueryClient handed to configureDb; undefined until configured. */
export const getDbQueryClient = (): QueryClient | undefined => runtimeConfig?.queryClient;

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
 * must call this on background/inactive and before logout teardown.
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
 */
export const replayJournal = (): number => getApplyRuntime().replay();

/**
 * Remove storage keys outside the library namespace - startup housekeeping that clears pre-v6
 * leftovers from the dedicated storage instance. Idempotent: a second run finds nothing.
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
    operationState = createOperationState({ storage, prefix: getStoragePrefix, now: () => Date.now() });
    operationState.hydrate();
  }
  return operationState;
};
