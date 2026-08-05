import { uniqBy } from 'es-toolkit';
import type { ApplyRuntime, CommitBus, IncrementalCommitBatch, AppliedOp, OperationTransition, StoragePlane } from '../../types';
import { getOperationState, getRuntimeGeneration } from '../../dsl/configure';
import { noteApplyFailure, noteCommit } from '../diagnostics';
import { getDbLogger } from '../logger';
import { poisonStoreReads, publishProjectedBatch, restoreStoreReads } from '../store';
import { reportSyncError } from '../syncError';
import { compositeKey } from '../serialize';
import { applyAtomically, touchedModelsOf } from './applyExecution';
import { getApplyTarget } from './applyTargetRegistry';

const pendingChanges = (transitions: readonly OperationTransition[]): Array<{ model: string; id: string }> =>
  uniqBy(
    getOperationState()
      .applyTransitions(transitions)
      .flatMap(operation => operation.rowIds.map(id => ({ model: operation.model, id })))
      .filter(change => change.model.length > 0),
    change => compositeKey(change.model, change.id)
  );

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
export const createApplyRuntime = (options: { storage: StoragePlane; prefix: () => string; bus: CommitBus }): ApplyRuntime => {
  const { storage, bus } = options;
  const generation = getRuntimeGeneration();
  let epoch = 0;
  const dirtyModels = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushCacheSnapshots = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (getRuntimeGeneration() !== generation) {
      dirtyModels.clear();
      return;
    }
    // A model leaves the dirty set only after its snapshot landed: a refused write keeps it
    // dirty and the next flush retries it with the freshest state.
    for (const model of [...dirtyModels]) {
      const target = getApplyTarget(model);
      for (const entry of target.persistEntries()) storage.set(entry.key, entry.value);
      target.ackPersist();
      dirtyModels.delete(model);
    }
  };

  const persistCommit = (ops: AppliedOp[], transitions: readonly OperationTransition[]): void => {
    // The ledger write is the durability boundary of the commit; it never waits for the tick.
    if (transitions.length > 0) {
      for (const entry of getOperationState().prepareTransitions(transitions)) storage.set(entry.key, entry.value);
    }
    for (const model of touchedModelsOf(ops)) dirtyModels.add(model);
    if (dirtyModels.size > 0 && flushTimer === null) {
      flushTimer = setTimeout(() => {
        // A refused cache write is not a crash: the model stays dirty, the next
        // commit or explicit flush retries it, and the refusal is reported.
        try {
          flushCacheSnapshots();
        } catch (error) {
          getDbLogger().error('cache snapshot flush failed, will retry', { error });
          reportSyncError(error, { source: 'apply' }, 'apply');
        }
      }, 0);
    }
  };

  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== getRuntimeGeneration()) throw new Error(`Stale commit envelope ${envelope.txId}`);
      const ops = [...envelope.entityOps, ...envelope.scopeOps];
      const transitions = [...envelope.operationTransitions];
      if (ops.length === 0 && transitions.length === 0) return { rows: [], scopes: [], mode: 'delta', scopeChanges: [] };
      epoch += 1;
      const commitEpoch = epoch;
      return publishProjectedBatch(
        bus,
        () => {
          let batch: IncrementalCommitBatch;
          let persistenceError: unknown;
          const persist = (): void => {
            try {
              persistCommit(ops, transitions);
            } catch (error) {
              persistenceError = error;
              throw error;
            }
          };
          try {
            batch = applyAtomically(ops, commitEpoch, persist);
          } catch (firstError) {
            if (persistenceError !== undefined) throw persistenceError;
            poisonStoreReads();
            try {
              restoreStoreReads();
              batch = applyAtomically(ops, commitEpoch, persist);
            } catch (error) {
              poisonStoreReads();
              noteApplyFailure();
              getDbLogger().error('apply failed after recovery replay', { epoch, firstError, error });
              reportSyncError(error, { source: 'apply' }, 'apply');
              throw error;
            }
          }
          batch.pending = pendingChanges(transitions);
          noteCommit();
          return batch;
        },
        { readyAfterApply: true }
      );
    },
    flushCacheSnapshots,
    currentEpoch: () => epoch
  };
};
