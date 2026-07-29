import { createJournal } from './journal';
import type {
  AcceptedRow,
  ApplyRuntime,
  ApplyTarget,
  CheckpointScheduler,
  CommitBus,
  CommitEnvelope,
  DestroyedRow,
  IncrementalCommitBatch,
  IncrementalScopeChange,
  JournalOp,
  JournalRecord,
  OperationTransition,
  StoragePlane,
  StoredRow,
  WriteOp
} from '../../types';
import { deriveEffects } from '../relations';
import { uniq, uniqBy } from 'es-toolkit';
import { compositeKey } from '../serialize';
import { noteApplyFailure, noteCommit } from '../diagnostics';
import { getDbLogger } from '../logger';
import { getDbRuntimeConfig, getOperationState, getRuntimeGeneration } from '../../dsl/configure';
import { publishProjectedBatch, runInApplyBatch } from '../store';
import { decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION } from '../persistenceCodec';

const isScopeOperation = (op: JournalOp): boolean => op.kind === 'scope' || op.kind === 'scope-delta';

const targets = new Map<string, ApplyTarget>();
const targetGenerations = new Map<string, number>();
let transactionSequence = 0;

/**
 * Register one model-owned application target for model application plans.
 *
 * A duplicate in one runtime generation throws; a later generation deliberately replaces the stale target so recreated runtimes can reuse stable model ids. Relation, GC, ingest, invalidation, and maintenance registries follow this same generation rule.
 */
export const registerApplyTarget = (model: string, target: ApplyTarget): (() => void) => {
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

export const getApplyTarget = (model: string): ApplyTarget => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};

export const getApplyTargets = (): Array<[string, ApplyTarget]> => [...targets];

const readPlannedRow = (overlay: Map<string, Map<string, StoredRow | null>>, model: string, id: string): StoredRow | undefined => {
  const modelOverlay = overlay.get(model);
  if (modelOverlay?.has(id)) return modelOverlay.get(id) ?? undefined;
  return getApplyTarget(model).readRow(id);
};

const writePlannedRow = (overlay: Map<string, Map<string, StoredRow | null>>, model: string, id: string, row: StoredRow | null): void => {
  const modelOverlay = overlay.get(model) ?? new Map<string, StoredRow | null>();
  modelOverlay.set(id, row);
  overlay.set(model, modelOverlay);
};

const readPlannedRows = (overlay: Map<string, Map<string, StoredRow | null>>, model: string): StoredRow[] => {
  const rows = new Map(
    getApplyTarget(model)
      .readAllRows()
      .flatMap(row => (typeof row.id === 'string' ? [[row.id, row] as const] : []))
  );
  for (const [id, row] of overlay.get(model) ?? []) {
    if (row === null) rows.delete(id);
    else rows.set(id, row);
  }
  return [...rows.values()];
};

const prepareOperations = (ops: WriteOp[], overlay: Map<string, Map<string, StoredRow | null>>) => {
  const preparedOps: JournalOp[] = [];
  const accepted: AcceptedRow[] = [];
  const destroyed: DestroyedRow[] = [];
  const operationTransitions: OperationTransition[] = [];
  for (const op of ops) {
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      const rows: StoredRow[] = [];
      for (const input of op.rows) {
        const inputId = typeof input === 'object' && input !== null && 'id' in input ? String((input as { id: unknown }).id) : '';
        const previous = inputId ? readPlannedRow(overlay, op.model, inputId) : undefined;
        const mergeBase = op.origin === 'replace' && typeof op.mergeBase === 'object' && op.mergeBase !== null ? (op.mergeBase as StoredRow) : undefined;
        const prepared = target.prepareUpsert(input, previous, op.origin, mergeBase, op.operationId);
        if (!prepared || (prepared.changedFields !== null && prepared.changedFields.length === 0)) continue;
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
      if (rows.length > 0) preparedOps.push({ kind: 'upsert', model: op.model, rows, ...(op.origin === 'replace' ? { origin: op.origin } : {}) });
      continue;
    }
    if (op.kind === 'patch') {
      const previous = readPlannedRow(overlay, op.model, op.id);
      const prepared = target.preparePatch(op.id, op.patch, previous, op.operationId);
      if (!prepared || (prepared.changedFields !== null && prepared.changedFields.length === 0)) continue;
      const id = String(prepared.row.id);
      writePlannedRow(overlay, op.model, id, prepared.row);
      preparedOps.push({ kind: 'upsert', model: op.model, rows: [prepared.row] });
      accepted.push({ model: op.model, id, before: previous, after: prepared.row, changedFields: prepared.changedFields });
      continue;
    }
    if (op.kind === 'counter') {
      const previous = readPlannedRow(overlay, op.model, op.id);
      if (!previous) continue;
      const value = previous[op.field];
      const numeric = typeof value === 'number' ? value : value == null ? 0 : Number(value);
      const prepared = target.preparePatch(op.id, { [op.field]: (Number.isFinite(numeric) ? numeric : 0) + op.delta }, previous);
      if (!prepared || (prepared.changedFields !== null && prepared.changedFields.length === 0)) continue;
      const id = String(prepared.row.id);
      writePlannedRow(overlay, op.model, id, prepared.row);
      preparedOps.push({ kind: 'upsert', model: op.model, rows: [prepared.row] });
      accepted.push({ model: op.model, id, before: previous, after: prepared.row, changedFields: prepared.changedFields });
      continue;
    }
    if (op.kind === 'destroy') {
      operationTransitions.push(...(op.operationTransitions ?? []));
      for (const id of op.ids) {
        const previous = readPlannedRow(overlay, op.model, id);
        if (previous) destroyed.push({ model: op.model, id, before: previous, origin: op.origin });
        writePlannedRow(overlay, op.model, id, null);
      }
      preparedOps.push({
        kind: 'destroy',
        model: op.model,
        ids: op.ids,
        ...(op.tombstone !== undefined ? { tombstone: op.tombstone } : {}),
        ...(op.origin ? { origin: op.origin } : {})
      });
      continue;
    }
    if (op.kind === 'scope-delta') {
      /** Planning-time key finalization: key-less appends (relation effects) get sort-aware keys here, never in apply. */
      const keyless = op.append.filter(entry => entry.orderKey === undefined).map(entry => entry.id);
      const placed = keyless.length > 0 ? new Map(target.planScopePlacement(op.scopeKey, keyless, (model, id) => readPlannedRow(overlay, model, id)).map(entry => [entry.id, entry.orderKey] as const)) : new Map<string, string>();
      preparedOps.push({
        kind: 'scope-delta',
        model: op.model,
        scopeKey: op.scopeKey,
        append: op.append.map(entry => ({ id: entry.id, orderKey: entry.orderKey ?? placed.get(entry.id)!, ...(entry.edge ? { edge: entry.edge } : {}) })),
        detach: op.detach
      });
      continue;
    }
    preparedOps.push(op);
  }
  return { ops: preparedOps, accepted, destroyed, operationTransitions };
};

const compileWritePlan = (initialOps: WriteOp[]): { ops: JournalOp[]; operationTransitions: OperationTransition[] } => {
  for (const op of initialOps) getApplyTarget(op.model);
  const overlay = new Map<string, Map<string, StoredRow | null>>();
  const sourceOps = [...initialOps];
  const planned: JournalOp[] = [];
  const operationTransitions: OperationTransition[] = [];
  let phase = prepareOperations(initialOps, overlay);
  planned.push(...phase.ops);
  operationTransitions.push(...phase.operationTransitions);
  const allAccepted = [...phase.accepted];
  while (phase.accepted.length > 0 || phase.destroyed.length > 0) {
    const effects = deriveEffects(phase.accepted, phase.destroyed, sourceOps, {
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
  const repositioned = new Map<string, JournalOp>();
  const repositionGroups = new Map<string, { model: string; scopeKey: string; ids: Set<string> }>();
  /** A row already placed or detached by this plan's own scope-deltas must not be re-added by a reposition. */
  const planTouched = new Set<string>();
  for (const op of planned) {
    if (op.kind !== 'scope-delta') continue;
    for (const entry of op.append) planTouched.add(compositeKey(op.model, op.scopeKey, entry.id));
    for (const id of op.detach) planTouched.add(compositeKey(op.model, op.scopeKey, id));
  }
  for (const row of allAccepted) {
    const target = getApplyTarget(row.model);
    for (const scopeKey of target.reactiveScopes?.([row.id]) ?? []) {
      if (planTouched.has(compositeKey(row.model, scopeKey, row.id))) continue;
      if (target.scopeSortMeta(scopeKey).kind === 'server-order') continue;
      if (!target.scopeOrderAffected(scopeKey, row.id, row.changedFields ?? null)) continue;
      const groupKey = compositeKey(row.model, scopeKey);
      const group = repositionGroups.get(groupKey) ?? { model: row.model, scopeKey, ids: new Set<string>() };
      group.ids.add(row.id);
      repositionGroups.set(groupKey, group);
    }
  }
  for (const group of repositionGroups.values()) {
    const target = getApplyTarget(group.model);
    const placements = target.planScopePlacement(group.scopeKey, [...group.ids], (model, id) => readPlannedRow(overlay, model, id));
    for (const placement of placements) {
      repositioned.set(compositeKey(group.model, group.scopeKey, placement.id), {
        kind: 'scope-delta',
        model: group.model,
        scopeKey: group.scopeKey,
        append: [{ id: placement.id, orderKey: placement.orderKey }],
        detach: []
      });
    }
  }
  planned.push(...repositioned.values());
  return { ops: planned, operationTransitions };
};

/**
 * Compile raw model intents into one complete callback-free plan before WAL. Entity work stays
 * ahead of scope membership so a reader cannot observe a membership pointing at a missing row.
 */
export const createCommitEnvelope = (
  ops: WriteOp[],
  explicitOperationTransitions: readonly OperationTransition[] = []
): CommitEnvelope => {
  const runtimeEpoch = getRuntimeGeneration();
  const planned = compileWritePlan(ops);
  const operationTransitions = [...planned.operationTransitions, ...explicitOperationTransitions];
  transactionSequence += 1;
  return {
    schemaVersion: 1,
    txId: `${runtimeEpoch}:${transactionSequence}`,
    epoch: runtimeEpoch,
    entityOps: planned.ops.filter(op => !isScopeOperation(op)),
    scopeOps: planned.ops.filter(isScopeOperation),
    operationEntries: operationTransitions.length > 0 ? getOperationState().prepareTransitions(operationTransitions) : [],
    operationTransitions
  } as unknown as CommitEnvelope;
};

const applyOperations = (ops: JournalOp[]): IncrementalCommitBatch => {
  const batch: IncrementalCommitBatch = { rows: [], scopes: [], mode: 'delta', scopeChanges: [] };
  const scopeChanges = new Map<string, IncrementalScopeChange>();
  const noteScope = (model: string, scopeKey: string, change: Omit<IncrementalScopeChange, 'model' | 'scopeKey'>): void => {
    const key = compositeKey(model, scopeKey);
    const current = scopeChanges.get(key) ?? { model, scopeKey };
    const mergeUpserts = (left?: Array<{ id: string; orderKey: string }>, right?: Array<{ id: string; orderKey: string }>) => {
      if (!left && !right) return undefined;
      return uniqBy([...(right ?? []), ...(left ?? [])], entry => entry.id);
    };
    scopeChanges.set(key, {
      ...current,
      entries: change.entries ?? current.entries,
      upserts: mergeUpserts(current.upserts, change.upserts),
      detachIds: current.detachIds || change.detachIds ? uniq([...(current.detachIds ?? []), ...(change.detachIds ?? [])]) : undefined
    });
  };
  const noteRows = (model: string, target: ApplyTarget, ids: string[]): void => {
    for (const scopeKey of target.reactiveScopes?.(ids) ?? []) {
      batch.scopes.push({ model, scopeKey });
    }
  };
  for (const op of ops) {
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      const changes = target.put(op.rows);
      for (const change of changes) {
        batch.rows.push({ model: op.model, id: change.id, fields: change.changedFields, kind: 'upsert' });
      }
      noteRows(
        op.model,
        target,
        changes.map(change => change.id)
      );
      if (op.origin === 'replace') batch.mode = 'replace';
    }
    if (op.kind === 'destroy') {
      const ids = target.destroy(op.ids, op.tombstone);
      for (const id of ids) {
        batch.rows.push({ model: op.model, id, fields: null, kind: 'destroy' });
      }
      noteRows(op.model, target, ids);
    }
    if (op.kind === 'scope') {
      target.scope(op.scopeKey, op.next);
      batch.scopes.push({ model: op.model, scopeKey: op.scopeKey });
      noteScope(op.model, op.scopeKey, { entries: op.next.entries.map(entry => ({ id: entry.id, orderKey: entry.orderKey })) });
    }
    if (op.kind === 'scope-delta') {
      target.scopeDelta(op.scopeKey, { append: op.append, detach: op.detach });
      batch.scopes.push({ model: op.model, scopeKey: op.scopeKey });
      noteScope(op.model, op.scopeKey, {
        upserts: op.append.map(row => ({ id: row.id, orderKey: row.orderKey })),
        detachIds: op.detach
      });
    }
  }
  batch.scopeChanges = [...scopeChanges.values()];
  return batch;
};

const touchedModelsOf = (ops: JournalOp[]): string[] => uniq(ops.map(op => op.model));

export const createApplyRuntime = (options: { storage: StoragePlane; prefix: () => string; bus: CommitBus; checkpoint?: CheckpointScheduler }): ApplyRuntime => {
  const { storage, prefix, bus, checkpoint } = options;
  const journal = createJournal(storage, prefix);
  let epoch = journal.lastEpoch();
  checkpoint?.setAfterFlush(flushedEpoch => {
    const entries = journal.pruneCommitted(flushedEpoch);
    if (entries.length > 0) storage.set(entries);
  });

  const persistImmediate = (ops: JournalOp[], record: JournalRecord): void => {
    const entries: Array<{ key: string; value: string | null }> = [];
    const models = touchedModelsOf(ops);
    for (const model of models) {
      entries.push(...getApplyTarget(model).persistEntries());
      entries.push({ key: `${prefix()}applied:${model}`, value: encodePersistence(record.epoch) });
    }
    entries.push(...journal.committedEntry(record));
    storage.set(entries);
    for (const model of models) getApplyTarget(model).ackPersist();
  };

  const persistedAppliedEpoch = (model: string): number => {
    const raw = storage.get(`${prefix()}applied:${model}`);
    if (raw == null) return 0;
    return decodeSupportedPersistence(raw, PERSISTENCE_SCHEMA_VERSION, (value): value is number => typeof value === 'number' && Number.isFinite(value)) ?? 0;
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
      let batch: IncrementalCommitBatch;
      try {
        batch = runInApplyBatch(() => applyOperations(ops));
      } catch (error) {
        noteApplyFailure();
        getDbLogger().error('apply failed', { epoch, error });
        try {
          getDbRuntimeConfig().defaults?.onSyncError?.(error instanceof Error ? error : new Error(String(error)), { source: 'apply' });
        } catch (observerError) {
          getDbLogger().error('apply onSyncError failed', { error: observerError });
        }
        throw error;
      }
      if (envelope.operationTransitions.length > 0) getOperationState().applyTransitions(envelope.operationTransitions);
      if (checkpoint) {
        storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
        checkpoint.notePlan(touchedModelsOf(ops), epoch);
      } else {
        persistImmediate(ops, record);
      }
      noteCommit();
      publishProjectedBatch(bus, batch, { readyAfterApply: true });
      return batch;
    },
    replay: () => {
      let replayed = 0;
      const appliedCache = new Map<string, number>();
      const replayedTransactions = new Set<string>();
      const appliedFor = (model: string): number => {
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
        if (checkpoint) {
          storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
          checkpoint.notePlan(touchedModelsOf(ops), record.epoch);
        } else {
          persistImmediate(ops, record);
        }
        noteCommit();
        publishProjectedBatch(bus, batch);
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
