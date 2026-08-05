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
const pendingChanges = transitions => (0, _esToolkit.uniqBy)((0, _configure.getOperationState)().applyTransitions(transitions).flatMap(operation => operation.rowIds.map(id => ({
  model: operation.model,
  id
}))).filter(change => change.model.length > 0), change => (0, _serialize.compositeKey)(change.model, change.id));

/**
 * One apply runtime per configured database: every model shares the same epoch counter and commit
 * bus, so one plan touching several models applies and persists as one transaction.
 *
 * Persistence splits by data class. The operation ledger (the user's unacked writes) is written
 * SYNCHRONOUSLY inside the commit - a kill right after a send still finds the operation and its
 * domain input on disk. Model cache snapshots (rows, scopes) coalesce per tick: back-to-back
 * commits in one tick encode each dirty model once, and a kill inside that window costs only
 * refetchable cache that the ledger can rebuild.
 */
const createApplyRuntime = options => {
  const {
    storage,
    bus
  } = options;
  const generation = (0, _configure.getRuntimeGeneration)();
  let epoch = 0;
  const dirtyModels = new Set();
  let flushTimer = null;
  const flushCacheSnapshots = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if ((0, _configure.getRuntimeGeneration)() !== generation) {
      dirtyModels.clear();
      return;
    }
    // A model leaves the dirty set only after its snapshot landed: a refused write keeps it
    // dirty and the next flush retries it with the freshest state.
    for (const model of [...dirtyModels]) {
      const target = (0, _applyTargetRegistry.getApplyTarget)(model);
      for (const entry of target.persistEntries()) storage.set(entry.key, entry.value);
      target.ackPersist();
      dirtyModels.delete(model);
    }
  };
  const persistCommit = (ops, transitions) => {
    // The ledger write is the durability boundary of the commit; it never waits for the tick.
    if (transitions.length > 0) {
      for (const entry of (0, _configure.getOperationState)().prepareTransitions(transitions)) storage.set(entry.key, entry.value);
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
        let batch;
        let persistenceError;
        const persist = () => {
          try {
            persistCommit(ops, transitions);
          } catch (error) {
            persistenceError = error;
            throw error;
          }
        };
        try {
          batch = (0, _applyExecution.applyAtomically)(ops, commitEpoch, persist);
        } catch (firstError) {
          if (persistenceError !== undefined) throw persistenceError;
          (0, _store.poisonStoreReads)();
          try {
            (0, _store.restoreStoreReads)();
            batch = (0, _applyExecution.applyAtomically)(ops, commitEpoch, persist);
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
        batch.pending = pendingChanges(transitions);
        (0, _diagnostics.noteCommit)();
        return batch;
      }, {
        readyAfterApply: true
      });
    },
    flushCacheSnapshots,
    currentEpoch: () => epoch
  };
};
exports.createApplyRuntime = createApplyRuntime;
//# sourceMappingURL=transaction.js.map