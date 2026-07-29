"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerApplyTarget = exports.getApplyTargets = exports.getApplyTarget = exports.createCommitEnvelope = exports.createApplyRuntime = void 0;
var _journal = require("./journal.js");
var _relations = require("../relations.js");
var _esToolkit = require("es-toolkit");
var _serialize = require("../serialize.js");
var _diagnostics = require("../diagnostics.js");
var _logger = require("../logger.js");
var _configure = require("../../dsl/configure.js");
var _store = require("../store.js");
var _persistenceCodec = require("../persistenceCodec.js");
const isScopeOperation = op => op.kind === 'scope' || op.kind === 'scope-delta';
const targets = new Map();
const targetGenerations = new Map();
let transactionSequence = 0;

/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale target so recreated runtimes can reuse stable model ids. Relation, GC, ingest, invalidation, and maintenance registries follow this same generation rule.
 */
const registerApplyTarget = (model, target) => {
  const generation = (0, _configure.getRuntimeGeneration)();
  if (targets.has(model) && targetGenerations.get(model) === generation) throw new Error(`Apply target already registered for model ${model}`);
  targets.set(model, target);
  targetGenerations.set(model, generation);
  return () => {
    if (targets.get(model) !== target) return;
    targets.delete(model);
    targetGenerations.delete(model);
  };
};
exports.registerApplyTarget = registerApplyTarget;
const getApplyTarget = model => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};
exports.getApplyTarget = getApplyTarget;
const getApplyTargets = () => [...targets];
exports.getApplyTargets = getApplyTargets;
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
  const operationTransitions = [];
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
          origin: op.origin,
          changedFields: prepared.changedFields
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
        after: prepared.row,
        changedFields: prepared.changedFields
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
        after: prepared.row,
        changedFields: prepared.changedFields
      });
      continue;
    }
    if (op.kind === 'destroy') {
      operationTransitions.push(...(op.operationTransitions ?? []));
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
      preparedOps.push({
        kind: 'destroy',
        model: op.model,
        ids: op.ids,
        ...(op.tombstone !== undefined ? {
          tombstone: op.tombstone
        } : {}),
        ...(op.origin ? {
          origin: op.origin
        } : {})
      });
      continue;
    }
    if (op.kind === 'scope-delta') {
      /** Planning-time key finalization: key-less appends (relation effects) get sort-aware keys here, never in apply. */
      const keyless = op.append.filter(entry => entry.orderKey === undefined).map(entry => entry.id);
      const placed = keyless.length > 0 ? new Map(target.planScopePlacement(op.scopeKey, keyless, (model, id) => readPlannedRow(overlay, model, id)).map(entry => [entry.id, entry.orderKey])) : new Map();
      preparedOps.push({
        kind: 'scope-delta',
        model: op.model,
        scopeKey: op.scopeKey,
        append: op.append.map(entry => ({
          id: entry.id,
          orderKey: entry.orderKey ?? placed.get(entry.id),
          ...(entry.edge ? {
            edge: entry.edge
          } : {})
        })),
        detach: op.detach
      });
      continue;
    }
    preparedOps.push(op);
  }
  return {
    ops: preparedOps,
    accepted,
    destroyed,
    operationTransitions
  };
};
const compileWritePlan = initialOps => {
  for (const op of initialOps) getApplyTarget(op.model);
  const overlay = new Map();
  const sourceOps = [...initialOps];
  const planned = [];
  const operationTransitions = [];
  let phase = prepareOperations(initialOps, overlay);
  planned.push(...phase.ops);
  operationTransitions.push(...phase.operationTransitions);
  const allAccepted = [...phase.accepted];
  while (phase.accepted.length > 0 || phase.destroyed.length > 0) {
    const effects = (0, _relations.deriveEffects)(phase.accepted, phase.destroyed, sourceOps, {
      read: (model, id) => readPlannedRow(overlay, model, id),
      rows: model => readPlannedRows(overlay, model)
    });
    if (effects.length === 0) break;
    sourceOps.push(...effects);
    phase = prepareOperations(effects, overlay);
    planned.push(...phase.ops);
    operationTransitions.push(...phase.operationTransitions);
    allAccepted.push(...phase.accepted);
  }
  /**
   * Repositions: an accepted row whose changed fields affect a sorted scope's order gets a fresh
   * key computed on planning; apply and replay move the member mechanically. Repositions change no
   * row content, so they derive no further effects.
   */
  const repositioned = new Map();
  /** A row already placed or detached by this plan's own scope-deltas must not be re-added by a reposition. */
  const planTouched = new Set();
  for (const op of planned) {
    if (op.kind !== 'scope-delta') continue;
    for (const entry of op.append) planTouched.add((0, _serialize.compositeKey)(op.model, op.scopeKey, entry.id));
    for (const id of op.detach) planTouched.add((0, _serialize.compositeKey)(op.model, op.scopeKey, id));
  }
  for (const row of allAccepted) {
    const target = getApplyTarget(row.model);
    for (const scopeKey of target.reactiveScopes?.([row.id]) ?? []) {
      if (planTouched.has((0, _serialize.compositeKey)(row.model, scopeKey, row.id))) continue;
      if (target.scopeSortMeta(scopeKey).kind === 'server-order') continue;
      if (!target.scopeOrderAffected(scopeKey, row.id, row.changedFields ?? null)) continue;
      const [placement] = target.planScopePlacement(scopeKey, [row.id], (model, id) => readPlannedRow(overlay, model, id));
      if (placement) repositioned.set((0, _serialize.compositeKey)(row.model, scopeKey, row.id), {
        kind: 'scope-delta',
        model: row.model,
        scopeKey,
        append: [{
          id: placement.id,
          orderKey: placement.orderKey
        }],
        detach: []
      });
    }
  }
  planned.push(...repositioned.values());
  return {
    ops: planned,
    operationTransitions
  };
};

/**
 * Compile raw model intents into one complete callback-free plan before WAL. Entity work stays
 * ahead of scope membership so a reader cannot observe a membership pointing at a missing row.
 */
const createCommitEnvelope = (ops, explicitOperationTransitions = []) => {
  const runtimeEpoch = (0, _configure.getRuntimeGeneration)();
  const planned = compileWritePlan(ops);
  const operationTransitions = [...planned.operationTransitions, ...explicitOperationTransitions];
  transactionSequence += 1;
  return {
    schemaVersion: 1,
    txId: `${runtimeEpoch}:${transactionSequence}`,
    epoch: runtimeEpoch,
    entityOps: planned.ops.filter(op => !isScopeOperation(op)),
    scopeOps: planned.ops.filter(isScopeOperation),
    operationEntries: operationTransitions.length > 0 ? (0, _configure.getOperationState)().prepareTransitions(operationTransitions) : [],
    operationTransitions
  };
};
exports.createCommitEnvelope = createCommitEnvelope;
const applyOperations = ops => {
  const batch = {
    rows: [],
    scopes: [],
    mode: 'delta',
    scopeChanges: []
  };
  const scopeChanges = new Map();
  const noteScope = (model, scopeKey, change) => {
    const key = (0, _serialize.compositeKey)(model, scopeKey);
    const current = scopeChanges.get(key) ?? {
      model,
      scopeKey
    };
    const mergeUpserts = (left, right) => {
      if (!left && !right) return undefined;
      return (0, _esToolkit.uniqBy)([...(right ?? []), ...(left ?? [])], entry => entry.id);
    };
    scopeChanges.set(key, {
      ...current,
      entries: change.entries ?? current.entries,
      upserts: mergeUpserts(current.upserts, change.upserts),
      detachIds: current.detachIds || change.detachIds ? (0, _esToolkit.uniq)([...(current.detachIds ?? []), ...(change.detachIds ?? [])]) : undefined
    });
  };
  const noteRows = (model, target, ids) => {
    for (const scopeKey of target.reactiveScopes?.(ids) ?? []) {
      batch.scopes.push({
        model,
        scopeKey
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
        entries: op.next.entries.map(entry => ({
          id: entry.id,
          orderKey: entry.orderKey
        }))
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
        upserts: op.append.map(row => ({
          id: row.id,
          orderKey: row.orderKey
        })),
        detachIds: op.detach
      });
    }
  }
  batch.scopeChanges = [...scopeChanges.values()];
  return batch;
};
const touchedModelsOf = ops => (0, _esToolkit.uniq)(ops.map(op => op.model));
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
        value: (0, _persistenceCodec.encodePersistence)(record.epoch)
      });
    }
    entries.push(...journal.committedEntry(record));
    storage.set(entries);
    for (const model of models) getApplyTarget(model).ackPersist();
  };
  const persistedAppliedEpoch = model => {
    const raw = storage.get(`${prefix()}applied:${model}`);
    if (raw == null) return 0;
    return (0, _persistenceCodec.decodeSupportedPersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, value => typeof value === 'number' && Number.isFinite(value)) ?? 0;
  };
  return {
    commit: envelope => {
      if (envelope.schemaVersion !== 1) throw new Error(`Unsupported commit envelope schema version ${String(envelope.schemaVersion)}`);
      if (envelope.epoch !== (0, _configure.getRuntimeGeneration)()) throw new Error(`Stale commit envelope ${envelope.txId}`);
      const ops = [...envelope.entityOps, ...envelope.scopeOps];
      epoch += 1;
      const record = {
        txId: envelope.txId,
        runtimeEpoch: envelope.epoch,
        epoch,
        status: 'pending',
        ops
      };
      storage.set([...journal.pendingEntry(record), ...envelope.operationEntries]);
      let batch;
      try {
        batch = (0, _store.runInApplyBatch)(() => applyOperations(ops));
      } catch (error) {
        (0, _diagnostics.noteApplyFailure)();
        (0, _logger.getDbLogger)().error('apply failed', {
          epoch,
          error
        });
        try {
          (0, _configure.getDbRuntimeConfig)().defaults?.onSyncError?.(error instanceof Error ? error : new Error(String(error)), {
            source: 'apply'
          });
        } catch (observerError) {
          (0, _logger.getDbLogger)().error('apply onSyncError failed', {
            error: observerError
          });
        }
        throw error;
      }
      if (envelope.operationTransitions.length > 0) (0, _configure.getOperationState)().applyTransitions(envelope.operationTransitions);
      if (checkpoint) {
        storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
        checkpoint.notePlan(touchedModelsOf(ops), epoch);
      } else {
        persistImmediate(ops, record);
      }
      (0, _diagnostics.noteCommit)();
      (0, _store.publishProjectedBatch)(bus, batch, {
        readyAfterApply: true
      });
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
        const batch = (0, _store.runInApplyBatch)(() => applyOperations(ops));
        if (checkpoint) {
          storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
          checkpoint.notePlan(touchedModelsOf(ops), record.epoch);
        } else {
          persistImmediate(ops, record);
        }
        (0, _diagnostics.noteCommit)();
        (0, _store.publishProjectedBatch)(bus, batch);
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
exports.createApplyRuntime = createApplyRuntime;
//# sourceMappingURL=transaction.js.map