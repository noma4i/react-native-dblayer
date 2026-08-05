"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createApplyRuntime = void 0;
var _esToolkit = require("es-toolkit");
var _configure = require("../../dsl/configure.js");
var _diagnostics = require("../diagnostics.js");
var _logger = require("../logger.js");
var _store = require("../store.js");
var _syncError = require("../syncError.js");
var _serialize = require("../serialize.js");
var _applyExecution = require("./applyExecution.js");
var _applyTargetRegistry = require("./applyTargetRegistry.js");
var _deltaLog = require("./deltaLog.js");
const pendingChanges = transitions => (0, _esToolkit.uniqBy)((0, _configure.getOperationState)().applyTransitions(transitions).flatMap(operation => operation.rowIds.map(id => ({
  model: operation.model,
  id
}))).filter(change => change.model.length > 0), change => (0, _serialize.compositeKey)(change.model, change.id));

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
const createApplyRuntime = options => {
  const {
    storage,
    bus
  } = options;
  const generation = (0, _configure.getRuntimeGeneration)();
  let epoch = 0;
  let deltaSeq = (0, _deltaLog.highestPersistedSeq)(storage, options.prefix()) + 1;
  const dirtyModels = new Set();
  /** Models each live (not yet compacted) delta touches - the compaction's coverage check. */
  const pendingDeltaModels = new Map();
  const snapseqCache = new Map();
  let flushTimer = null;
  const snapseqOf = model => {
    const cached = snapseqCache.get(model);
    if (cached !== undefined) return cached;
    const persisted = (0, _deltaLog.readSnapseq)(storage, options.prefix(), model);
    snapseqCache.set(model, persisted);
    return persisted;
  };
  const flushCacheSnapshots = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if ((0, _configure.getRuntimeGeneration)() !== generation) {
      dirtyModels.clear();
      pendingDeltaModels.clear();
      return;
    }
    // A model leaves the dirty set only after its snapshot landed: a refused write keeps it
    // dirty and the next flush retries it with the freshest state.
    const coveredSeq = deltaSeq - 1;
    for (const model of [...dirtyModels]) {
      const target = (0, _applyTargetRegistry.getApplyTarget)(model);
      for (const entry of target.persistEntries()) storage.set(entry.key, entry.value);
      // The snapshot order is strict: entries, then the model's snapseq marker. A kill between
      // them replays the covered deltas over the fresh snapshot, which converges (full rows,
      // idempotent scope ops).
      storage.set((0, _deltaLog.snapseqKey)(options.prefix(), model), String(coveredSeq));
      snapseqCache.set(model, coveredSeq);
      target.ackPersist();
      dirtyModels.delete(model);
    }
    // Delete only the deltas every touched model's snapshot now covers.
    for (const [seq, models] of [...pendingDeltaModels]) {
      if (!models.every(model => snapseqOf(model) >= seq)) continue;
      storage.set((0, _deltaLog.deltaKey)(options.prefix(), seq), null);
      pendingDeltaModels.delete(seq);
    }
  };
  const persistCommit = (ops, transitions) => {
    // The ledger write is one durability boundary of the commit; the delta key is the other.
    if (transitions.length > 0) {
      for (const entry of (0, _configure.getOperationState)().prepareTransitions(transitions)) storage.set(entry.key, entry.value);
    }
    if (ops.length > 0) {
      const seq = deltaSeq;
      deltaSeq += 1;
      // A refused delta write is contained: the commit still lands in memory, the models stay
      // dirty, and the next successful flush covers the state without the delta. Only the
      // ledger write above may fail the commit - unacked user writes are irrecoverable.
      try {
        storage.set((0, _deltaLog.deltaKey)(options.prefix(), seq), (0, _deltaLog.encodeDelta)(seq, ops));
        pendingDeltaModels.set(seq, (0, _applyExecution.touchedModelsOf)(ops));
      } catch (error) {
        deltaSeq = seq;
        (0, _logger.getDbLogger)().error('commit delta write refused, snapshot flush will cover', {
          seq,
          error
        });
        (0, _syncError.reportSyncError)(error, {
          source: 'apply'
        }, 'apply');
      }
    }
    for (const model of (0, _applyExecution.touchedModelsOf)(ops)) dirtyModels.add(model);
    if (dirtyModels.size > 0 && flushTimer === null) {
      flushTimer = setTimeout(() => {
        // A refused cache write is not a crash: the model stays dirty, the next
        // commit or explicit flush retries it, and the refusal is reported.
        try {
          flushCacheSnapshots();
        } catch (error) {
          (0, _logger.getDbLogger)().error('cache snapshot flush failed, will retry', {
            error
          });
          (0, _syncError.reportSyncError)(error, {
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
      return (0, _applyExecution.applyAtomically)(ops, commitEpoch, persistOnce);
    } catch (firstError) {
      if (persistenceError !== undefined) throw persistenceError;
      (0, _store.poisonStoreReads)();
      try {
        (0, _store.restoreStoreReads)();
        return (0, _applyExecution.applyAtomically)(ops, commitEpoch, persistOnce);
      } catch (error) {
        (0, _store.poisonStoreReads)();
        (0, _diagnostics.noteApplyFailure)();
        (0, _logger.getDbLogger)().error('apply failed after recovery replay', {
          epoch,
          firstError,
          error
        });
        (0, _syncError.reportSyncError)(error, {
          source: 'apply'
        }, 'apply');
        throw error;
      }
    }
  };
  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== (0, _configure.getRuntimeGeneration)()) throw new Error(`Stale commit envelope ${envelope.txId}`);
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
      return (0, _store.publishProjectedBatch)(bus, () => {
        const batch = applyWithRecovery(ops, commitEpoch, () => persistCommit(ops, transitions));
        batch.pending = pendingChanges(transitions);
        (0, _diagnostics.noteCommit)();
        return batch;
      }, {
        readyAfterApply: true
      });
    },
    replayPersistedDeltas: () => {
      // Boot roll-forward: snapshots first (lazy plane hydration), then every delta op whose model
      // snapshot does not cover it yet. Replayed deltas mark their models dirty, so the next
      // compaction folds them into snapshots and deletes them; they are NOT re-written as deltas.
      const deltas = (0, _deltaLog.readDeltaLog)(storage, options.prefix());
      for (const delta of deltas) {
        const ops = delta.ops.filter(op => snapseqOf(op.model) < delta.seq);
        pendingDeltaModels.set(delta.seq, (0, _applyExecution.touchedModelsOf)(delta.ops));
        if (ops.length === 0) continue;
        epoch += 1;
        try {
          // Boot readiness belongs to bootDb's markStoresReady, not to each replayed batch.
          (0, _store.publishProjectedBatch)(bus, () => applyWithRecovery(ops, epoch, () => (0, _applyExecution.touchedModelsOf)(ops).forEach(model => dirtyModels.add(model))));
        } catch (error) {
          // A delta the current code cannot apply cuts the tail exactly like a delta it cannot read.
          const tail = deltas.filter(candidate => candidate.seq >= delta.seq);
          for (const candidate of tail) {
            storage.set((0, _deltaLog.deltaKey)(options.prefix(), candidate.seq), null);
            pendingDeltaModels.delete(candidate.seq);
          }
          for (const key of storage.keys(`${options.prefix()}query`)) storage.set(key, null);
          (0, _logger.getDbLogger)().error('delta replay failed, tail cut', {
            seq: delta.seq,
            error
          });
          (0, _syncError.reportSyncError)(error, {
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
exports.createApplyRuntime = createApplyRuntime;
//# sourceMappingURL=transaction.js.map