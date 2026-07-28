"use strict";

import { createJournal } from "./journal.js";
import { deriveEffects } from "../relations.js";
import { uniq, uniqBy } from 'es-toolkit';
import { compositeKey } from "../serialize.js";
import { noteApplyFailure, noteCommit } from "../diagnostics.js";
import { getDbLogger } from "../logger.js";
import { getDbRuntimeConfig, getRuntimeGeneration } from "../../dsl/configure.js";
import { runInApplyBatch, syncStoreScopes } from "../store.js";
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from "../persistenceCodec.js";
const isScopeOperation = op => op.kind === 'scope' || op.kind === 'scope-delta';
const targets = new Map();
const targetGenerations = new Map();
let transactionSequence = 0;

/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale target so recreated runtimes can reuse stable model ids. Relation, GC, ingest, invalidation, and maintenance registries follow this same generation rule.
 */
export const registerApplyTarget = (model, target) => {
  const generation = getRuntimeGeneration();
  if (targets.has(model) && targetGenerations.get(model) === generation) throw new Error(`Apply target already registered for model ${model}`);
  targets.set(model, target);
  targetGenerations.set(model, generation);
  return () => {
    if (targets.get(model) !== target) return;
    targets.delete(model);
    targetGenerations.delete(model);
  };
};
export const getApplyTarget = model => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};
export const getApplyTargets = () => [...targets];
const readPlannedRow = (overlay, model, id) => {
  const modelOverlay = overlay.get(model);
  if (modelOverlay?.has(id)) return modelOverlay.get(id) ?? undefined;
  return getApplyTarget(model).readRow(id);
};
const writePlannedRow = (overlay, model, id, row) => {
  const modelOverlay = overlay.get(model) ?? new Map();
  modelOverlay.set(id, row);
  overlay.set(model, modelOverlay);
};
const readPlannedRows = (overlay, model) => {
  const rows = new Map(getApplyTarget(model).readAllRows().flatMap(row => typeof row.id === 'string' ? [[row.id, row]] : []));
  for (const [id, row] of overlay.get(model) ?? []) {
    if (row === null) rows.delete(id);else rows.set(id, row);
  }
  return [...rows.values()];
};
const prepareOperations = (ops, overlay) => {
  const preparedOps = [];
  const accepted = [];
  const destroyed = [];
  for (const op of ops) {
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      const rows = [];
      for (const input of op.rows) {
        const inputId = typeof input === 'object' && input !== null && 'id' in input ? String(input.id) : '';
        const previous = inputId ? readPlannedRow(overlay, op.model, inputId) : undefined;
        const mergeBase = op.origin === 'replace' && typeof op.mergeBase === 'object' && op.mergeBase !== null ? op.mergeBase : undefined;
        const prepared = target.prepareUpsert(input, previous, op.origin, mergeBase, op.operationId);
        if (!prepared || prepared.changedFields !== null && prepared.changedFields.length === 0) continue;
        const id = prepared.row.id;
        if (typeof id !== 'string' || id.length === 0) throw new Error(`Prepared row for ${op.model} has no string id`);
        writePlannedRow(overlay, op.model, id, prepared.row);
        rows.push(prepared.row);
        accepted.push({
          model: op.model,
          id,
          before: op.origin === 'replace' ? mergeBase : previous,
          after: prepared.row,
          origin: op.origin
        });
      }
      if (rows.length > 0) preparedOps.push({
        kind: 'upsert',
        model: op.model,
        rows,
        ...(op.origin === 'replace' ? {
          origin: op.origin
        } : {})
      });
      continue;
    }
    if (op.kind === 'patch') {
      const previous = readPlannedRow(overlay, op.model, op.id);
      const prepared = target.preparePatch(op.id, op.patch, previous, op.operationId);
      if (!prepared || prepared.changedFields !== null && prepared.changedFields.length === 0) continue;
      const id = String(prepared.row.id);
      writePlannedRow(overlay, op.model, id, prepared.row);
      preparedOps.push({
        kind: 'upsert',
        model: op.model,
        rows: [prepared.row]
      });
      accepted.push({
        model: op.model,
        id,
        before: previous,
        after: prepared.row
      });
      continue;
    }
    if (op.kind === 'counter') {
      const previous = readPlannedRow(overlay, op.model, op.id);
      if (!previous) continue;
      const value = previous[op.field];
      const numeric = typeof value === 'number' ? value : value == null ? 0 : Number(value);
      const prepared = target.preparePatch(op.id, {
        [op.field]: (Number.isFinite(numeric) ? numeric : 0) + op.delta
      }, previous);
      if (!prepared || prepared.changedFields !== null && prepared.changedFields.length === 0) continue;
      const id = String(prepared.row.id);
      writePlannedRow(overlay, op.model, id, prepared.row);
      preparedOps.push({
        kind: 'upsert',
        model: op.model,
        rows: [prepared.row]
      });
      accepted.push({
        model: op.model,
        id,
        before: previous,
        after: prepared.row
      });
      continue;
    }
    if (op.kind === 'destroy') {
      for (const id of op.ids) {
        const previous = readPlannedRow(overlay, op.model, id);
        if (previous) destroyed.push({
          model: op.model,
          id,
          before: previous,
          origin: op.origin
        });
        writePlannedRow(overlay, op.model, id, null);
      }
      preparedOps.push(op);
      continue;
    }
    preparedOps.push(op);
  }
  return {
    ops: preparedOps,
    accepted,
    destroyed
  };
};
const compileWritePlan = initialOps => {
  for (const op of initialOps) getApplyTarget(op.model);
  const overlay = new Map();
  const sourceOps = [...initialOps];
  const planned = [];
  let phase = prepareOperations(initialOps, overlay);
  planned.push(...phase.ops);
  while (phase.accepted.length > 0 || phase.destroyed.length > 0) {
    const effects = deriveEffects(phase.accepted, phase.destroyed, sourceOps, {
      read: (model, id) => readPlannedRow(overlay, model, id),
      rows: model => readPlannedRows(overlay, model)
    });
    if (effects.length === 0) break;
    sourceOps.push(...effects);
    phase = prepareOperations(effects, overlay);
    planned.push(...phase.ops);
  }
  return planned;
};

/**
 * Compile raw model intents into one complete callback-free plan before WAL. Entity work stays
 * ahead of scope membership so a reader cannot observe a membership pointing at a missing row.
 */
export const createCommitEnvelope = (ops, extraEntries) => {
  const runtimeEpoch = getRuntimeGeneration();
  const planned = compileWritePlan(ops);
  transactionSequence += 1;
  return {
    schemaVersion: 1,
    txId: `${runtimeEpoch}:${transactionSequence}`,
    epoch: runtimeEpoch,
    entityOps: planned.filter(op => !isScopeOperation(op)),
    scopeOps: planned.filter(isScopeOperation),
    extraEntries: extraEntries?.() ?? []
  };
};
const applyOperations = ops => {
  const batch = {
    rows: [],
    scopes: [],
    mode: 'delta',
    scopeChanges: []
  };
  const scopeChanges = new Map();
  const noteScope = (model, scopeKey, change) => {
    const key = compositeKey(model, scopeKey);
    const current = scopeChanges.get(key) ?? {
      model,
      scopeKey
    };
    const mergeIds = (left, right) => left || right ? uniq([...(left ?? []), ...(right ?? [])]) : undefined;
    const mergeAppendEntries = (left, right) => {
      if (!left && !right) return undefined;
      return uniqBy([...(right ?? []), ...(left ?? [])], entry => entry.id);
    };
    scopeChanges.set(key, {
      ...current,
      ids: mergeIds(current.ids, change.ids),
      appendIds: mergeIds(current.appendIds, change.appendIds),
      appendEntries: mergeAppendEntries(current.appendEntries, change.appendEntries),
      detachIds: mergeIds(current.detachIds, change.detachIds),
      rebuild: current.rebuild === true || change.rebuild === true
    });
  };
  const noteRows = (model, target, ids) => {
    for (const scopeKey of target.reactiveScopes?.(ids) ?? []) {
      batch.scopes.push({
        model,
        scopeKey
      });
      noteScope(model, scopeKey, {
        ids
      });
    }
  };
  for (const op of ops) {
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      const changes = target.put(op.rows);
      for (const change of changes) {
        batch.rows.push({
          model: op.model,
          id: change.id,
          fields: change.changedFields,
          kind: 'upsert'
        });
      }
      noteRows(op.model, target, changes.map(change => change.id));
      if (op.origin === 'replace') batch.mode = 'replace';
    }
    if (op.kind === 'destroy') {
      const ids = target.destroy(op.ids, op.tombstone);
      for (const id of ids) {
        batch.rows.push({
          model: op.model,
          id,
          fields: null,
          kind: 'destroy'
        });
      }
      noteRows(op.model, target, ids);
    }
    if (op.kind === 'scope') {
      target.scope(op.scopeKey, op.next);
      batch.scopes.push({
        model: op.model,
        scopeKey: op.scopeKey
      });
      noteScope(op.model, op.scopeKey, {
        rebuild: true
      });
    }
    if (op.kind === 'scope-delta') {
      target.scopeDelta(op.scopeKey, {
        append: op.append,
        detach: op.detach
      });
      batch.scopes.push({
        model: op.model,
        scopeKey: op.scopeKey
      });
      noteScope(op.model, op.scopeKey, {
        appendIds: op.append.map(row => row.id),
        appendEntries: op.append.filter(row => typeof row.order === 'number').map(row => ({
          id: row.id,
          order: row.order
        })),
        detachIds: op.detach
      });
    }
  }
  batch.scopeChanges = [...scopeChanges.values()];
  return batch;
};
const touchedModelsOf = ops => uniq(ops.map(op => op.model));
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
    const entries = journal.pruneCommitted(flushedEpoch);
    if (entries.length > 0) storage.set(entries);
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
    entries.push(...journal.committedEntry(record));
    storage.set(entries);
    for (const model of models) getApplyTarget(model).ackPersist();
  };
  const persistedAppliedEpoch = model => {
    const raw = storage.get(`${prefix()}applied:${model}`);
    if (raw == null) return 0;
    return decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, value => typeof value === 'number' && Number.isFinite(value)) ?? 0;
  };
  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== getRuntimeGeneration()) throw new Error(`Stale commit envelope ${envelope.txId}`);
      const ops = [...envelope.entityOps, ...envelope.scopeOps];
      epoch += 1;
      const record = {
        txId: envelope.txId,
        runtimeEpoch: envelope.epoch,
        epoch,
        status: 'pending',
        ops
      };
      storage.set([...journal.pendingEntry(record), ...envelope.extraEntries]);
      let batch;
      try {
        batch = runInApplyBatch(() => applyOperations(ops));
        syncStoreScopes(batch, getApplyTarget, true);
      } catch (error) {
        noteApplyFailure();
        getDbLogger().error('apply failed', {
          epoch,
          error
        });
        try {
          getDbRuntimeConfig().defaults?.onSyncError?.(error instanceof Error ? error : new Error(String(error)), {
            source: 'apply'
          });
        } catch (observerError) {
          getDbLogger().error('apply onSyncError failed', {
            error: observerError
          });
        }
        throw error;
      }
      if (checkpoint) {
        storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
        checkpoint.notePlan(touchedModelsOf(ops), epoch);
      } else {
        persistImmediate(ops, record);
      }
      noteCommit();
      bus.publish(batch);
      return batch;
    },
    replay: () => {
      let replayed = 0;
      const appliedCache = new Map();
      const replayedTransactions = new Set();
      const appliedFor = model => {
        const cached = appliedCache.get(model);
        if (cached !== undefined) return cached;
        const value = persistedAppliedEpoch(model);
        appliedCache.set(model, value);
        return value;
      };
      for (const record of journal.allRecords()) {
        if (replayedTransactions.has(record.txId)) {
          if (record.status === 'pending') storage.set(journal.committedEntry(record, checkpoint?.flushedEpoch()));
          continue;
        }
        replayedTransactions.add(record.txId);
        const ops = record.ops.filter(op => appliedFor(op.model) < record.epoch);
        epoch = Math.max(epoch, record.epoch);
        if (ops.length === 0) {
          if (record.status === 'pending') storage.set(journal.committedEntry(record, checkpoint?.flushedEpoch()));
          continue;
        }
        const batch = runInApplyBatch(() => applyOperations(ops));
        syncStoreScopes(batch, getApplyTarget);
        if (checkpoint) {
          storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
          checkpoint.notePlan(touchedModelsOf(ops), record.epoch);
        } else {
          persistImmediate(ops, record);
        }
        noteCommit();
        bus.publish(batch);
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
//# sourceMappingURL=transaction.js.map