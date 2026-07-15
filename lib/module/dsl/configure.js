"use strict";

import { mmkvStoragePlane } from "../core/planes/storagePlane.js";
import { setDbLogger } from "../core/logger.js";
import { setDbTransport } from "../core/transport.js";
import { createCommitBus } from "../core/apply/commitBus.js";
import { createCheckpointScheduler } from "../core/apply/checkpoint.js";
import { createApplyRuntime, getApplyTarget } from "../core/apply/transaction.js";
import { createOperationState } from "../core/planes/operationState.js";
import { expandPlan } from "../core/relations.js";
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
let checkpointScheduler = null;
let runtimeGeneration = 0;
const commitBus = createCommitBus();

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/** Configure v6 runtime seams and defaults. */
export const configureDb = options => {
  runtimeGeneration += 1;
  runtimeConfig = {
    ...options,
    storage: options.storage ?? mmkvStoragePlane()
  };
  applyRuntime = null;
  operationState = null;
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  setDbTransport(options.transport);
  if (options.logger) setDbLogger(options.logger);
};
export const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};
export const getStoragePrefix = () => STORAGE_PREFIX;

/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export const getRuntimeGeneration = () => runtimeGeneration;

/** Internal: establish a new generation before the reset fence tears down the old runtime. */
export const advanceRuntimeGeneration = () => {
  runtimeGeneration += 1;
};
export const getCommitBus = () => commitBus;

/** App-owned TanStack QueryClient handed to configureDb; undefined until configured. */
export const getDbQueryClient = () => runtimeConfig?.queryClient;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 * Persistence is WAL + checkpoint: plans write only their journal record; model snapshots flush
 * through the checkpoint scheduler off the hot path.
 */
export const getApplyRuntime = () => {
  if (!applyRuntime) {
    const {
      storage,
      defaults
    } = getDbRuntimeConfig();
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
    applyRuntime = createApplyRuntime({
      storage,
      prefix: getStoragePrefix,
      bus: commitBus,
      checkpoint: checkpointScheduler
    });
  }
  return applyRuntime;
};

/**
 * Force a checkpoint flush NOW - pending model snapshots hit storage in one batch. The host app
 * must call this on background/inactive and before logout teardown.
 */
export const flushPersistence = () => {
  checkpointScheduler?.flushNow();
};

/** Persist plane mutations made by maintenance outside an apply-plan epoch. */
export const noteMaintenancePersistence = models => {
  getApplyRuntime();
  checkpointScheduler?.noteMaintenance(models);
};

/**
 * Idempotently re-apply journal records not yet covered by each model's persisted applied-epoch
 * marker. The host app must call this ONCE at startup, after configureDb and after every model
 * module has been imported (apply targets registered) - records touching unregistered models throw.
 * Returns the number of replayed records.
 */
export const replayJournal = () => {
  const runtime = getApplyRuntime();
  const replayed = runtime.replay();
  const operations = getOperationState();
  const orphaned = operations.hydratedPending();
  for (const operation of orphaned) {
    if (operation.tempIds.length > 0) {
      runtime.apply(expandPlan([{
        kind: 'destroy',
        model: operation.model,
        ids: operation.tempIds
      }]));
    }
    operations.close(operation.operationId, 'rolledback');
  }
  if (orphaned.length > 0) getDbRuntimeConfig().storage.set(operations.persistEntries());
  return replayed;
};

/**
 * Remove storage keys outside the library namespace - startup housekeeping that clears pre-v6
 * leftovers from the dedicated storage instance. Idempotent: a second run finds nothing.
 */
export const purgeForeignStorageKeys = () => {
  const {
    storage
  } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  if (foreign.length > 0) storage.set(foreign.map(key => ({
    key,
    value: null
  })));
  return foreign.length;
};

/** Internal: kill-switch discards pending snapshots (storage is being wiped anyway). */
export const cancelPersistence = () => {
  checkpointScheduler?.cancel();
};

/** Internal: discard per-runtime WAL/checkpoint caches after storage has been wiped. */
export const resetPersistenceRuntime = () => {
  checkpointScheduler?.cancel();
  checkpointScheduler = null;
  applyRuntime = null;
  operationState = null;
};

/** One operation ledger per configured database - optimistic identity, dedupe and keyed sequences. */
export const getOperationState = () => {
  if (!operationState) {
    const {
      storage
    } = getDbRuntimeConfig();
    operationState = createOperationState({
      storage,
      prefix: getStoragePrefix,
      now: () => Date.now()
    });
    operationState.hydrate();
  }
  return operationState;
};
//# sourceMappingURL=configure.js.map