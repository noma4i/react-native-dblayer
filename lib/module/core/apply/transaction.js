"use strict";

import { getOperationState, getRuntimeGeneration } from "../../dsl/configure.js";
import { isNonNegativeSafeInteger } from "../../utils/normalizeHelpers.js";
import { noteApplyFailure, noteCommit, noteDataLoss } from "../diagnostics.js";
import { getDbLogger } from "../logger.js";
import { decodePersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "../persistenceCodec.js";
import { poisonStoreReads, publishProjectedBatch, restoreStoreReads } from "../store.js";
import { reportSyncError } from "../syncError.js";
import { applyAtomically, touchedModelsOf } from "./applyExecution.js";
import { getApplyTarget } from "./applyTargetRegistry.js";
import { createJournal } from "./journal.js";
export const createApplyRuntime = options => {
  const {
    storage,
    prefix,
    bus,
    checkpoint
  } = options;
  const journal = createJournal(storage, prefix);
  let epoch = journal.lastEpoch();
  checkpoint?.setAfterFlush(flushedEpoch => {
    const prunePlan = journal.pruneCommitted(flushedEpoch);
    if (prunePlan.entries.length > 0) storage.set(prunePlan.entries);
    prunePlan.commit();
  });
  const persistImmediate = (ops, record) => {
    const entries = [];
    const models = touchedModelsOf(ops);
    for (const model of models) {
      entries.push(...getApplyTarget(model).persistEntries());
      entries.push({
        key: `${prefix()}applied:${model}`,
        value: encodePersistence(record.epoch)
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
    const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, isNonNegativeSafeInteger);
    if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
    if (decoded.kind === 'ok') return decoded.value;
    storage.set([{
      key: markerKey,
      value: null
    }]);
    noteDataLoss('corrupt-applied-epoch', model, 1);
    return 0;
  };
  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== getRuntimeGeneration()) throw new Error(`Stale commit envelope ${envelope.txId}`);
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
      return publishProjectedBatch(bus, () => {
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
          batch = applyAtomically(ops, record.epoch, persist);
        } catch (firstError) {
          if (persistenceError !== undefined) throw persistenceError;
          poisonStoreReads();
          try {
            restoreStoreReads();
            batch = applyAtomically(ops, record.epoch, persist);
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
        if (envelope.operationTransitions.length > 0) getOperationState().applyTransitions(envelope.operationTransitions);
        if (checkpoint) {
          checkpoint.notePlan(touchedModelsOf(ops), epoch);
        } else {
          for (const model of touchedModelsOf(ops)) getApplyTarget(model).ackPersist();
        }
        noteCommit();
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
        publishProjectedBatch(bus, () => {
          let batch;
          try {
            restoreStoreReads();
            batch = applyAtomically(ops, record.epoch, () => {
              if (checkpoint) {
                const commitPlan = journal.committedEntry(record, checkpoint.flushedEpoch());
                storage.set(commitPlan.entries);
                commitPlan.commit();
              } else {
                persistImmediate(ops, record);
              }
            });
          } catch (error) {
            poisonStoreReads();
            throw error;
          }
          if (checkpoint) {
            checkpoint.notePlan(touchedModelsOf(ops), record.epoch);
          } else {
            for (const model of touchedModelsOf(ops)) getApplyTarget(model).ackPersist();
          }
          noteCommit();
          return batch;
        });
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
//# sourceMappingURL=transaction.js.map