import type { ApplyRuntime, CheckpointScheduler, CommitBus, IncrementalCommitBatch, JournalOp, JournalRecord, StoragePlane } from '../../types';
import { getOperationState, getRuntimeGeneration } from '../../dsl/configure';
import { isNonNegativeSafeInteger } from '../../utils/normalizeHelpers';
import { noteApplyFailure, noteCommit, noteDataLoss } from '../diagnostics';
import { getDbLogger } from '../logger';
import { decodePersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from '../persistenceCodec';
import { poisonStoreReads, publishProjectedBatch, restoreStoreReads } from '../store';
import { reportSyncError } from '../syncError';
import { applyAtomically, touchedModelsOf } from './applyExecution';
import { getApplyTarget } from './applyTargetRegistry';
import { createJournal } from './journal';

export const createApplyRuntime = (options: { storage: StoragePlane; prefix: () => string; bus: CommitBus; checkpoint?: CheckpointScheduler }): ApplyRuntime => {
  const { storage, prefix, bus, checkpoint } = options;
  const journal = createJournal(storage, prefix);
  let epoch = journal.lastEpoch();
  checkpoint?.setAfterFlush(flushedEpoch => {
    const prunePlan = journal.pruneCommitted(flushedEpoch);
    if (prunePlan.entries.length > 0) storage.set(prunePlan.entries);
    prunePlan.commit();
  });

  const persistImmediate = (ops: JournalOp[], record: JournalRecord): void => {
    const entries: Array<{ key: string; value: string | null }> = [];
    const models = touchedModelsOf(ops);
    for (const model of models) {
      entries.push(...getApplyTarget(model).persistEntries());
      entries.push({ key: `${prefix()}applied:${model}`, value: encodePersistence(record.epoch) });
    }
    const commitPlan = journal.committedEntry(record);
    entries.push(...commitPlan.entries);
    storage.set(entries);
    commitPlan.commit();
    for (const model of models) getApplyTarget(model).ackPersist();
  };

  const persistedAppliedEpoch = (model: string): number => {
    const markerKey = `${prefix()}applied:${model}`;
    const raw = storage.get(markerKey);
    if (raw == null) return 0;
    const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, isNonNegativeSafeInteger);
    if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
    if (decoded.kind === 'ok') return decoded.value;
    storage.set([{ key: markerKey, value: null }]);
    noteDataLoss('corrupt-applied-epoch', model, 1);
    return 0;
  };

  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== getRuntimeGeneration()) throw new Error(`Stale commit envelope ${envelope.txId}`);
      const ops = [...envelope.entityOps, ...envelope.scopeOps];
      epoch += 1;
      const record: JournalRecord = {
        txId: envelope.txId,
        runtimeEpoch: envelope.epoch,
        epoch,
        status: 'pending',
        ops
      };
      storage.set([...journal.pendingEntry(record), ...envelope.operationEntries]);
      return publishProjectedBatch(
        bus,
        () => {
          let batch: IncrementalCommitBatch;
          try {
            batch = applyAtomically(ops);
          } catch (firstError) {
            poisonStoreReads();
            try {
              restoreStoreReads();
              batch = applyAtomically(ops);
            } catch (error) {
              poisonStoreReads();
              noteApplyFailure();
              getDbLogger().error('apply failed after recovery replay', { epoch, firstError, error });
              reportSyncError(error, { source: 'apply' }, 'apply');
              throw error;
            }
          }
          if (envelope.operationTransitions.length > 0) getOperationState().applyTransitions(envelope.operationTransitions);
          if (checkpoint) {
            const commitPlan = journal.committedEntry(record, checkpoint.flushedEpoch());
            storage.set(commitPlan.entries);
            commitPlan.commit();
            checkpoint.notePlan(touchedModelsOf(ops), epoch);
          } else {
            persistImmediate(ops, record);
          }
          noteCommit();
          return batch;
        },
        { readyAfterApply: true }
      );
    },
    replay: () => {
      let replayed = 0;
      const appliedCache = new Map<string, number>();
      const appliedFor = (model: string): number => {
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
          let batch: IncrementalCommitBatch;
          try {
            restoreStoreReads();
            batch = applyAtomically(ops);
          } catch (error) {
            poisonStoreReads();
            throw error;
          }
          if (checkpoint) {
            const commitPlan = journal.committedEntry(record, checkpoint.flushedEpoch());
            storage.set(commitPlan.entries);
            commitPlan.commit();
            checkpoint.notePlan(touchedModelsOf(ops), record.epoch);
          } else {
            persistImmediate(ops, record);
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
