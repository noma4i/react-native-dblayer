'use strict';

import { mmkvStoragePlane } from '../core/planes/storagePlane.js';
import { setDbLogger } from '../core/logger.js';
import { setDbTransport } from '../core/transport.js';
import { createCommitBus } from '../core/apply/commitBus.js';
import { createCheckpointScheduler } from '../core/apply/checkpoint.js';
import { createApplyRuntime, getApplyTarget } from '../core/apply/transaction.js';
import { createOperationState } from '../core/planes/operationState.js';
import { expandPlan } from '../core/relations.js';
import { isTempId } from '../utils/generateTempId.js';
import { registerReset } from '../core/reset.js';
import { resetCollectionRegistry } from '../core/tanstack/facade.js';
import { seedCollections, startCollectionMirror } from '../core/tanstack/mirror.js';
let runtimeConfig = null;
let applyRuntime = null;
let operationState = null;
let checkpointScheduler = null;
let runtimeGeneration = 0;
let replayCompleted = false;
const commitBus = createCommitBus();
let stopCollectionMirror = null;
let collectionRegistryResetRegistered = false;

/** Single flat key namespace for everything the library persists. */
const STORAGE_PREFIX = 'dbl:';

/**
 * Configure the injected runtime seams (transport, storage, query client, logger) and package-wide
 * defaults. Must be called once before any model, query, or mutation runs; calling it again advances the
 * runtime generation, discards cached apply/operation runtimes, and re-applies transport/logger.
 *
 * Most apps should call `bootDb(options)` instead: it wraps this call with the recommended
 * `replayJournal`/`collectGarbage`/`purgeForeignStorageKeys` startup sequence. `configureDb` stays
 * exported directly for callers with a different startup sequencing need.
 *
 * @param options.transport GraphQL transport (`query`/`mutation`) used by `defineQuery`/`defineMutation`.
 * @param options.storage Synchronous key/value seam for persistence; defaults to `mmkvStoragePlane()`.
 * @param options.queryClient TanStack Query client shared with `defineQuery`'s hooks; optional.
 * @param options.logger Package logger seam; optional, defaults to the built-in logger.
 * @param options.defaults Package-wide freshness/pagination/error-observation defaults (see `DbDefaults`).
 */
export const configureDb = options => {
  runtimeGeneration += 1;
  replayCompleted = false;
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
  getApplyRuntime();
  stopCollectionMirror?.();
  resetCollectionRegistry();
  stopCollectionMirror = startCollectionMirror(commitBus);
  if (!collectionRegistryResetRegistered) {
    registerReset(resetCollectionRegistry);
    collectionRegistryResetRegistered = true;
  }
};
export const getDbRuntimeConfig = () => {
  if (!runtimeConfig) throw new Error('configureDb must be called before using dblayer');
  return runtimeConfig;
};

/** Internal: true once `configureDb` has run. Lets lifecycle helpers no-op safely before configuration. */
export const isDbConfigured = () => runtimeConfig !== null;

/** Internal: reports whether the current runtime completed journal replay. */
export const hasReplayedJournal = () => replayCompleted;
export const getStoragePrefix = () => STORAGE_PREFIX;

/** Monotonic identity for the configured runtime; async continuations must not cross it. */
export const getRuntimeGeneration = () => runtimeGeneration;

/** Internal: establish a new generation before the reset fence tears down the old runtime. */
export const advanceRuntimeGeneration = () => {
  runtimeGeneration += 1;
};
export const getCommitBus = () => commitBus;

/**
 * App-owned TanStack QueryClient handed to configureDb; undefined until configured.
 *
 * @returns The configured TanStack QueryClient, or undefined if configureDb has not been called.
 */
export const getDbQueryClient = () => runtimeConfig?.queryClient;

/**
 * One apply runtime per configured database: every model shares the same journal, epoch counter
 * and commit bus, so one plan touching several models applies and persists as one transaction.
 * Persistence is WAL + checkpoint: plans write only their journal record; model snapshots flush
 * through the checkpoint scheduler off the hot path.
 */
export const getApplyRuntime = () => {
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
 * must call this on background/inactive and before logout teardown. `suspendDb()` calls this for you
 * as part of the recommended background/teardown sequence.
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
 *
 * Most apps should call `bootDb(options)` instead, which runs this in the recommended startup order
 * (`configureDb` -> `replayJournal` -> `collectGarbage` -> `purgeForeignStorageKeys`) and surfaces this
 * function's return value as `{ replayed }`.
 *
 * @returns The number of journal records replayed.
 */
export const replayJournal = () => {
  const runtime = getApplyRuntime();
  const storage = getDbRuntimeConfig().storage;
  const rowPrefix = `${getStoragePrefix()}row:`;
  const models = new Set();
  for (const key of storage.keys(rowPrefix)) {
    const model = key.slice(rowPrefix.length).split(':', 1)[0];
    if (model) models.add(model);
  }
  seedCollections([...models]);
  const replayed = runtime.replay();
  const operations = getOperationState();
  const hasApplyTarget = model => {
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
      runtime.apply(
        expandPlan([
          {
            kind: 'destroy',
            model: operation.model,
            ids: operation.tempIds,
            tombstone: false
          }
        ])
      );
    }
    operations.close(operation.operationId, 'rolledback');
  }
  const candidates = new Map();
  const noteCandidate = (model, id) => {
    if (typeof id !== 'string' || !isTempId(id)) return;
    const ids = candidates.get(model) ?? new Set();
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
      const record = JSON.parse(raw);
      for (const operation of record.ops ?? []) {
        if (operation.kind !== 'upsert' || !operation.model) continue;
        for (const row of operation.rows ?? []) noteCandidate(operation.model, row.id);
      }
    } catch {}
  }
  const pendingTempIds = new Set(operations.pending().flatMap(operation => operation.tempIds));
  for (const [model, ids] of candidates) {
    const orphanIds = [...ids].filter(id => !pendingTempIds.has(id));
    if (orphanIds.length > 0 && hasApplyTarget(model))
      runtime.apply(
        expandPlan([
          {
            kind: 'destroy',
            model,
            ids: orphanIds,
            tombstone: false
          }
        ])
      );
  }
  flushPersistence();
  replayCompleted = true;
  return replayed;
};

/**
 * Remove storage keys outside the library namespace - startup housekeeping that clears pre-v6
 * leftovers from the dedicated storage instance. Idempotent: a second run finds nothing.
 *
 * Most apps should call `bootDb(options)` instead, which runs this last in the recommended startup order.
 *
 * @returns The number of removed foreign storage keys.
 */
export const purgeForeignStorageKeys = () => {
  const { storage } = getDbRuntimeConfig();
  const foreign = storage.keys('').filter(key => !key.startsWith(STORAGE_PREFIX));
  if (foreign.length > 0)
    storage.set(
      foreign.map(key => ({
        key,
        value: null
      }))
    );
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
    const { storage } = getDbRuntimeConfig();
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
