"use strict";

import { uniqBy } from 'es-toolkit';
import { getOperationState, getRuntimeGeneration } from "../../dsl/configure.js";
import { noteApplyFailure, noteCommit } from "../diagnostics.js";
import { getDbLogger } from "../logger.js";
import { poisonStoreReads, publishProjectedBatch, restoreStoreReads } from "../store.js";
import { reportSyncError } from "../syncError.js";
import { compositeKey } from "../serialize.js";
import { applyAtomically, touchedModelsOf } from "./applyExecution.js";
import { getApplyTarget } from "./applyTargetRegistry.js";
import { deltaKey, encodeDelta, highestPersistedSeq, readDeltaLog, readSnapseq, snapseqKey } from "./deltaLog.js";
const pendingChanges = transitions => uniqBy(getOperationState().applyTransitions(transitions).flatMap(operation => operation.rowIds.map(id => ({
  model: operation.model,
  id
}))).filter(change => change.model.length > 0), change => compositeKey(change.model, change.id));

/**
 * One apply runtime per configured database: every model shares the same epoch counter and commit
 * bus, so one plan touching several models applies and persists as one transaction.
 *
 * Every commit is durable before it returns. The operation ledger (the user's unacked writes) and
 * the commit's cache delta (one atomic `delta:<seq>` key carrying rows AND scope changes) are both
 * written synchronously - a kill at any later point finds the commit on disk, and the row/membership
 * pair can never tear. Model snapshots coalesce per tick as COMPACTION: the flush writes each dirty
 * model's snapshot, advances its `snapseq`, and deletes the deltas the snapshots now cover.
 */
export const createApplyRuntime = options => {
  const {
    storage,
    bus
  } = options;
  const generation = getRuntimeGeneration();
  let epoch = 0;
  let deltaSeq = highestPersistedSeq(storage, options.prefix()) + 1;
  const dirtyModels = new Set();
  /** Models each live (not yet compacted) delta touches - the compaction's coverage check. */
  const pendingDeltaModels = new Map();
  const snapseqCache = new Map();
  let flushTimer = null;
  const snapseqOf = model => {
    const cached = snapseqCache.get(model);
    if (cached !== undefined) return cached;
    const persisted = readSnapseq(storage, options.prefix(), model);
    snapseqCache.set(model, persisted);
    return persisted;
  };
  const flushCacheSnapshots = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (getRuntimeGeneration() !== generation) {
      dirtyModels.clear();
      pendingDeltaModels.clear();
      return;
    }
    // A model leaves the dirty set only after its snapshot landed: a refused write keeps it
    // dirty and the next flush retries it with the freshest state.
    const coveredSeq = deltaSeq - 1;
    for (const model of [...dirtyModels]) {
      const target = getApplyTarget(model);
      for (const entry of target.persistEntries()) storage.set(entry.key, entry.value);
      // The snapshot order is strict: entries, then the model's snapseq marker. A kill between
      // them replays the covered deltas over the fresh snapshot, which converges (full rows,
      // idempotent scope ops).
      storage.set(snapseqKey(options.prefix(), model), String(coveredSeq));
      snapseqCache.set(model, coveredSeq);
      target.ackPersist();
      dirtyModels.delete(model);
    }
    // Delete only the deltas every touched model's snapshot now covers.
    for (const [seq, models] of [...pendingDeltaModels]) {
      if (!models.every(model => snapseqOf(model) >= seq)) continue;
      storage.set(deltaKey(options.prefix(), seq), null);
      pendingDeltaModels.delete(seq);
    }
  };
  const persistCommit = (ops, transitions) => {
    // The ledger write is one durability boundary of the commit; the delta key is the other.
    if (transitions.length > 0) {
      for (const entry of getOperationState().prepareTransitions(transitions)) storage.set(entry.key, entry.value);
    }
    if (ops.length > 0) {
      const seq = deltaSeq;
      deltaSeq += 1;
      // A refused delta write is contained: the commit still lands in memory, the models stay
      // dirty, and the next successful flush covers the state without the delta. Only the
      // ledger write above may fail the commit - unacked user writes are irrecoverable.
      try {
        storage.set(deltaKey(options.prefix(), seq), encodeDelta(seq, ops));
        pendingDeltaModels.set(seq, touchedModelsOf(ops));
      } catch (error) {
        deltaSeq = seq;
        getDbLogger().error('commit delta write refused, snapshot flush will cover', {
          seq,
          error
        });
        reportSyncError(error, {
          source: 'apply'
        }, 'apply');
      }
    }
    for (const model of touchedModelsOf(ops)) dirtyModels.add(model);
    if (dirtyModels.size > 0 && flushTimer === null) {
      flushTimer = setTimeout(() => {
        // A refused cache write is not a crash: the model stays dirty, the next
        // commit or explicit flush retries it, and the refusal is reported.
        try {
          flushCacheSnapshots();
        } catch (error) {
          getDbLogger().error('cache snapshot flush failed, will retry', {
            error
          });
          reportSyncError(error, {
            source: 'apply'
          }, 'apply');
        }
      }, 0);
    }
  };
  const applyWithRecovery = (ops, commitEpoch, persist) => {
    let persistenceError;
    const persistOnce = () => {
      try {
        persist();
      } catch (error) {
        persistenceError = error;
        throw error;
      }
    };
    try {
      return applyAtomically(ops, commitEpoch, persistOnce);
    } catch (firstError) {
      if (persistenceError !== undefined) throw persistenceError;
      poisonStoreReads();
      try {
        restoreStoreReads();
        return applyAtomically(ops, commitEpoch, persistOnce);
      } catch (error) {
        poisonStoreReads();
        noteApplyFailure();
        getDbLogger().error('apply failed after recovery replay', {
          epoch,
          firstError,
          error
        });
        reportSyncError(error, {
          source: 'apply'
        }, 'apply');
        throw error;
      }
    }
  };
  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== getRuntimeGeneration()) throw new Error(`Stale commit envelope ${envelope.txId}`);
      const ops = [...envelope.entityOps, ...envelope.scopeOps];
      const transitions = [...envelope.operationTransitions];
      if (ops.length === 0 && transitions.length === 0) return {
        rows: [],
        scopes: [],
        mode: 'delta',
        scopeChanges: []
      };
      epoch += 1;
      const commitEpoch = epoch;
      return publishProjectedBatch(bus, () => {
        const batch = applyWithRecovery(ops, commitEpoch, () => persistCommit(ops, transitions));
        batch.pending = pendingChanges(transitions);
        noteCommit();
        return batch;
      }, {
        readyAfterApply: true
      });
    },
    replayPersistedDeltas: () => {
      // Boot roll-forward: snapshots first (lazy plane hydration), then every delta op whose model
      // snapshot does not cover it yet. Replayed deltas mark their models dirty, so the next
      // compaction folds them into snapshots and deletes them; they are NOT re-written as deltas.
      const deltas = readDeltaLog(storage, options.prefix());
      for (const delta of deltas) {
        const ops = delta.ops.filter(op => snapseqOf(op.model) < delta.seq);
        pendingDeltaModels.set(delta.seq, touchedModelsOf(delta.ops));
        if (ops.length === 0) continue;
        epoch += 1;
        try {
          // Boot readiness belongs to bootDb's markStoresReady, not to each replayed batch.
          publishProjectedBatch(bus, () => applyWithRecovery(ops, epoch, () => touchedModelsOf(ops).forEach(model => dirtyModels.add(model))));
        } catch (error) {
          // A delta the current code cannot apply cuts the tail exactly like a delta it cannot read.
          const tail = deltas.filter(candidate => candidate.seq >= delta.seq);
          for (const candidate of tail) {
            storage.set(deltaKey(options.prefix(), candidate.seq), null);
            pendingDeltaModels.delete(candidate.seq);
          }
          for (const key of storage.keys(`${options.prefix()}query`)) storage.set(key, null);
          getDbLogger().error('delta replay failed, tail cut', {
            seq: delta.seq,
            error
          });
          reportSyncError(error, {
            source: 'apply'
          }, 'apply');
          break;
        }
      }
    },
    flushCacheSnapshots,
    currentEpoch: () => epoch
  };
};
//# sourceMappingURL=transaction.js.map