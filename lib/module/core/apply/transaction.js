"use strict";

import { uniqBy } from 'es-toolkit';
import { getOperationState, getRuntimeGeneration } from "../../dsl/configure.js";
import { isNonNegativeSafeInteger } from "../../utils/normalizeHelpers.js";
import { noteApplyFailure, noteCommit, noteDataLoss } from "../diagnostics.js";
import { getDbLogger } from "../logger.js";
import { decodePersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "../persistenceCodec.js";
import { compositeKey } from "../serialize.js";
import { poisonStoreReads, publishProjectedBatch, restoreStoreReads } from "../store.js";
import { reportSyncError } from "../syncError.js";
import { applyAtomically, touchedModelsOf } from "./applyExecution.js";
import { getApplyTarget } from "./applyTargetRegistry.js";
import { createJournal, readCheckpointEpoch } from "./journal.js";
const pendingChanges = transitions => uniqBy(getOperationState().applyTransitions(transitions).flatMap(operation => operation.rowIds.map(id => ({
  model: operation.model,
  id
}))).filter(change => change.model.length > 0), change => compositeKey(change.model, change.id));
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
    const keys = journal.coveredKeys(flushedEpoch);
    for (const key of keys) storage.set(key, null);
  });
  const persistedAppliedEpoch = model => {
    const markerKey = `${prefix()}applied:${model}`;
    const raw = storage.get(markerKey);
    if (raw == null) return 0;
    const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, isNonNegativeSafeInteger);
    if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
    if (decoded.kind === 'ok') return decoded.value;
    storage.set(markerKey, null);
    noteDataLoss('corrupt-applied-epoch', model, 1);
    return 0;
  };
  const persistImmediate = record => {
    const models = touchedModelsOf(record.ops);
    const entries = [];
    for (const model of models) {
      entries.push(...getApplyTarget(model).persistEntries());
      entries.push({
        key: `${prefix()}applied:${model}`,
        value: encodePersistence(record.epoch)
      });
    }
    entries.push(...getOperationState().prepareTransitions(record.operationTransitions));
    entries.push({
      key: `${prefix()}meta`,
      value: encodePersistence({
        lastCheckpointEpoch: record.epoch
      })
    });
    for (const entry of entries) storage.set(entry.key, entry.value);
  };
  const applyRecord = (record, ops, transitions, readyAfterApply) => publishProjectedBatch(bus, () => {
    let batch;
    let persistenceError;
    const persist = () => {
      if (checkpoint) return;
      try {
        persistImmediate({
          ...record,
          ops,
          operationTransitions: transitions
        });
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
    batch.pending = pendingChanges(transitions);
    if (checkpoint) {
      checkpoint.notePlan(touchedModelsOf(ops), record.epoch);
    } else {
      for (const model of touchedModelsOf(ops)) getApplyTarget(model).ackPersist();
    }
    noteCommit();
    return batch;
  }, {
    readyAfterApply
  });
  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== getRuntimeGeneration()) throw new Error(`Stale commit envelope ${envelope.txId}`);
      const ops = [...envelope.entityOps, ...envelope.scopeOps];
      if (ops.length === 0 && envelope.operationTransitions.length === 0) return {
        rows: [],
        scopes: [],
        mode: 'delta',
        scopeChanges: []
      };
      epoch += 1;
      const record = {
        txId: envelope.txId,
        runtimeEpoch: envelope.epoch,
        epoch,
        ops,
        operationTransitions: [...envelope.operationTransitions]
      };
      const journalEntry = journal.entry(record);
      storage.set(journalEntry.key, journalEntry.value);
      return applyRecord(record, record.ops, record.operationTransitions, true);
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
      getOperationState();
      const operationCheckpointEpoch = readCheckpointEpoch(storage, prefix());
      for (const record of journal.allRecords()) {
        const ops = record.ops.filter(op => appliedFor(op.model) < record.epoch);
        const transitions = record.epoch > operationCheckpointEpoch ? record.operationTransitions : [];
        epoch = Math.max(epoch, record.epoch);
        if (ops.length === 0 && transitions.length === 0) continue;
        applyRecord(record, ops, transitions, false);
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
//# sourceMappingURL=transaction.js.map