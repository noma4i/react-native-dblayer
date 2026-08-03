"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createApplyRuntime = void 0;
var _configure = require("../../dsl/configure.js");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
var _diagnostics = require("../diagnostics.js");
var _logger = require("../logger.js");
var _persistenceCodec = require("../persistenceCodec.js");
var _store = require("../store.js");
var _syncError = require("../syncError.js");
var _applyExecution = require("./applyExecution.js");
var _applyTargetRegistry = require("./applyTargetRegistry.js");
var _journal = require("./journal.js");
const createApplyRuntime = options => {
  const {
    storage,
    prefix,
    bus,
    checkpoint
  } = options;
  const journal = (0, _journal.createJournal)(storage, prefix);
  let epoch = journal.lastEpoch();
  checkpoint?.setAfterFlush(flushedEpoch => {
    const prunePlan = journal.pruneCommitted(flushedEpoch);
    if (prunePlan.entries.length > 0) storage.set(prunePlan.entries);
    prunePlan.commit();
  });
  const persistImmediate = (ops, record) => {
    const entries = [];
    const models = (0, _applyExecution.touchedModelsOf)(ops);
    for (const model of models) {
      entries.push(...(0, _applyTargetRegistry.getApplyTarget)(model).persistEntries());
      entries.push({
        key: `${prefix()}applied:${model}`,
        value: (0, _persistenceCodec.encodePersistence)(record.epoch)
      });
    }
    const commitPlan = journal.committedEntry(record);
    entries.push(...commitPlan.entries);
    storage.set(entries);
    commitPlan.commit();
  };
  const persistedAppliedEpoch = model => {
    const markerKey = `${prefix()}applied:${model}`;
    const raw = storage.get(markerKey);
    if (raw == null) return 0;
    const decoded = (0, _persistenceCodec.decodePersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, _normalizeHelpers.isNonNegativeSafeInteger);
    if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
    if (decoded.kind === 'ok') return decoded.value;
    storage.set([{
      key: markerKey,
      value: null
    }]);
    (0, _diagnostics.noteDataLoss)('corrupt-applied-epoch', model, 1);
    return 0;
  };
  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== (0, _configure.getRuntimeGeneration)()) throw new Error(`Stale commit envelope ${envelope.txId}`);
      const ops = [...envelope.entityOps, ...envelope.scopeOps];
      if (ops.length === 0 && envelope.operationTransitions.length === 0) {
        return {
          rows: [],
          scopes: [],
          mode: 'delta',
          scopeChanges: []
        };
      }
      epoch += 1;
      const record = {
        txId: envelope.txId,
        runtimeEpoch: envelope.epoch,
        epoch,
        status: 'pending',
        ops
      };
      storage.set([...journal.pendingEntry(record), ...envelope.operationEntries]);
      return (0, _store.publishProjectedBatch)(bus, () => {
        let batch;
        let persistenceError;
        const persist = () => {
          try {
            if (checkpoint) {
              const commitPlan = journal.committedEntry(record, checkpoint.flushedEpoch());
              storage.set(commitPlan.entries);
              commitPlan.commit();
            } else {
              persistImmediate(ops, record);
            }
          } catch (error) {
            persistenceError = error;
            throw error;
          }
        };
        try {
          batch = (0, _applyExecution.applyAtomically)(ops, record.epoch, persist);
        } catch (firstError) {
          if (persistenceError !== undefined) throw persistenceError;
          (0, _store.poisonStoreReads)();
          try {
            (0, _store.restoreStoreReads)();
            batch = (0, _applyExecution.applyAtomically)(ops, record.epoch, persist);
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
        if (envelope.operationTransitions.length > 0) (0, _configure.getOperationState)().applyTransitions(envelope.operationTransitions);
        if (checkpoint) {
          checkpoint.notePlan((0, _applyExecution.touchedModelsOf)(ops), epoch);
        } else {
          for (const model of (0, _applyExecution.touchedModelsOf)(ops)) (0, _applyTargetRegistry.getApplyTarget)(model).ackPersist();
        }
        (0, _diagnostics.noteCommit)();
        return batch;
      }, {
        readyAfterApply: true
      });
    },
    replay: () => {
      let replayed = 0;
      const appliedCache = new Map();
      const appliedFor = model => {
        const cached = appliedCache.get(model);
        if (cached !== undefined) return cached;
        const value = persistedAppliedEpoch(model);
        appliedCache.set(model, value);
        return value;
      };
      for (const record of journal.allRecords()) {
        const ops = record.ops.filter(op => appliedFor(op.model) < record.epoch);
        epoch = Math.max(epoch, record.epoch);
        if (ops.length === 0) {
          if (record.status === 'pending') {
            const commitPlan = journal.committedEntry(record, checkpoint?.flushedEpoch());
            storage.set(commitPlan.entries);
            commitPlan.commit();
          }
          continue;
        }
        (0, _store.publishProjectedBatch)(bus, () => {
          let batch;
          try {
            (0, _store.restoreStoreReads)();
            batch = (0, _applyExecution.applyAtomically)(ops, record.epoch, () => {
              if (checkpoint) {
                const commitPlan = journal.committedEntry(record, checkpoint.flushedEpoch());
                storage.set(commitPlan.entries);
                commitPlan.commit();
              } else {
                persistImmediate(ops, record);
              }
            });
          } catch (error) {
            (0, _store.poisonStoreReads)();
            throw error;
          }
          if (checkpoint) {
            checkpoint.notePlan((0, _applyExecution.touchedModelsOf)(ops), record.epoch);
          } else {
            for (const model of (0, _applyExecution.touchedModelsOf)(ops)) (0, _applyTargetRegistry.getApplyTarget)(model).ackPersist();
          }
          (0, _diagnostics.noteCommit)();
          return batch;
        });
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
exports.createApplyRuntime = createApplyRuntime;
//# sourceMappingURL=transaction.js.map