import type { CommitBatch, CommitBus, IncrementalCommitBatch, IncrementalScopeChange } from './commitBus';
import type { CheckpointScheduler } from './checkpoint';
import type { JournalOp, JournalRecord } from './journal';
import { createJournal } from './journal';
import type { StoragePlane } from '../planes/storagePlane';
import type { WriteOrigin } from '../../dsl/defineModel';
import { deriveEffects, type AcceptedRow, type DestroyedRow } from '../relations';
import { uniq, uniqBy } from 'es-toolkit';
import { compositeKey } from '../serialize';
import { noteApplyFailure, noteCommit } from '../diagnostics';
import { getDbLogger } from '../logger';
import { getDbRuntimeConfig, getRuntimeGeneration } from '../../dsl/configure';
import { syncEngineBatch } from '../../engine/EngineAdapter';

const commitEnvelopeBrand: unique symbol = Symbol('commit-envelope');

/** Complete write plan accepted by the sole runtime write entry point. */
export type CommitEnvelope = {
  schemaVersion: 1;
  txId: string;
  epoch: number;
  entityOps: JournalOp[];
  scopeOps: JournalOp[];
  identityOps: JournalOp[];
  relationOps: JournalOp[];
  operationOps: JournalOp[];
  extraEntries?: () => Array<{ key: string; value: string | null }>;
  readonly [commitEnvelopeBrand]: true;
};

const isScopeOperation = (op: JournalOp): boolean => op.kind === 'scope' || op.kind === 'scope-delta';

/**
 * Build one opaque-to-consumers commit plan from the model-owned operation planners.
 * Entity work is always applied before scope membership, so a reader can never observe a scope
 * entry that points at a missing row.
 */
export const createCommitEnvelope = (ops: JournalOp[], extraEntries?: () => Array<{ key: string; value: string | null }>): CommitEnvelope => ({
  schemaVersion: 1,
  txId: `runtime:${getRuntimeGeneration()}`,
  epoch: getRuntimeGeneration(),
  entityOps: ops.filter(op => !isScopeOperation(op)),
  scopeOps: ops.filter(isScopeOperation),
  identityOps: [],
  relationOps: [],
  operationOps: [],
  [commitEnvelopeBrand]: true,
  ...(extraEntries ? { extraEntries } : {})
});

/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to checkpoint flushes (or, on bare runtimes, to the immediate batch).
 */
export type ApplyTarget = {
  readRow(id: string): Record<string, unknown> | undefined;
  readAllRows(): Array<Record<string, unknown>>;
  readScopeOrder(scopeKey: string): string[];
  readScopeOrderRevision(scopeKey: string): number;
  readScopeGeneration(scopeKey: string): number;
  scopeOrderAffected(scopeKey: string, id: string, fields: string[] | null): boolean;
  scopeSortMeta(scopeKey: string): { kind: 'server-order' } | { kind: 'field'; field: string; dir: 'asc' | 'desc' } | { kind: 'comparator' };
  readAllScopeKeys(): string[];
  upsert(rows: unknown[], origin?: Exclude<WriteOrigin, 'patch' | 'snapshot'>, mergeBase?: Record<string, unknown>, operationId?: string): Array<{ id: string; changedFields: string[] | null }>;
  patch(id: string, patch: Record<string, unknown>, operationId?: string): { id: string; changedFields: string[] | null } | null;
  destroy(ids: string[], tombstone?: boolean): string[];
  counter(id: string, field: string, delta: number, next?: number): boolean;
  counterValue(id: string, field: string): number | null;
  scope(scopeKey: string, next: unknown): void;
  scopeDelta(scopeKey: string, delta: { append: Array<{ id: string; edge?: Record<string, unknown>; order?: number }>; detach: string[] }): void;
  reactiveScopes?(ids: string[]): string[];
  persistEntries(): Array<{ key: string; value: string | null }>;
  /** Clears the dirty markers captured by the last persistEntries; called only after a successful storage write. */
  ackPersist(): void;
};

export type ApplyRuntime = {
  /**
   * Apply one plan: journal stores raw intent; effects derive inside the transaction from accepted
   * effective rows, so replay re-derives them.
   *
   * @note Honesty contract, not full STM: a partial in-memory commit is possible ONLY when a
   * consumer callback throws mid-plan (for example, a relation callback).
   * The WAL record for that epoch stays `pending` (never marked `committed`) - replay deterministically
   * re-applies it from scratch on the next boot, so persisted state never diverges from the journal.
   * On throw: `noteApplyFailure()` + `getDbLogger().error('apply failed', ...)` +
   * `defaults.onSyncError({source:'apply'})` fire, then the exception rethrows to the caller (mutation's
   * rollback path, ingest's `reportModelIngestError`, or replay's own boot-failure surface).
   */
  commit(envelope: CommitEnvelope): CommitBatch;
  /**
   * Startup recovery: idempotently re-apply journal records not yet covered by each model's
   * persisted applied-epoch marker (survives torn checkpoint batches - the marker sits AFTER its
   * snapshot in the flush order); returns replayed record count.
   */
  replay(): number;
  currentEpoch(): number;
};

const targets = new Map<string, ApplyTarget>();
const targetGenerations = new Map<string, number>();

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

type ApplyPhase = { batch: IncrementalCommitBatch; accepted: AcceptedRow[]; destroyed: DestroyedRow[] };

const applyOperations = (ops: JournalOp[]): ApplyPhase => {
  const batch: IncrementalCommitBatch = { rows: [], scopes: [], mode: 'delta', scopeChanges: [] };
  const accepted: AcceptedRow[] = [];
  const destroyed: DestroyedRow[] = [];
  const scopeChanges = new Map<string, IncrementalScopeChange>();
  const noteScope = (model: string, scopeKey: string, change: Omit<IncrementalScopeChange, 'model' | 'scopeKey'>): void => {
    const key = compositeKey(model, scopeKey);
    const current = scopeChanges.get(key) ?? { model, scopeKey };
    const mergeIds = (left?: string[], right?: string[]) => (left || right ? uniq([...(left ?? []), ...(right ?? [])]) : undefined);
    const mergeAppendEntries = (left?: Array<{ id: string; order: number }>, right?: Array<{ id: string; order: number }>) => {
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
  const noteRows = (model: string, target: ApplyTarget, ids: string[]): void => {
    for (const scopeKey of target.reactiveScopes?.(ids) ?? []) {
      batch.scopes.push({ model, scopeKey });
      noteScope(model, scopeKey, { ids });
    }
  };
  for (const op of ops) {
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      const beforeById = new Map(op.rows.flatMap(row => typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'string' ? [[(row as { id: string }).id, target.readRow((row as { id: string }).id)] as const] : []));
      const changes = target.upsert(op.rows, op.origin, op.origin === 'replace' ? op.mergeBase as Record<string, unknown> | undefined : undefined, op.operationId);
      for (const change of changes) {
        batch.rows.push({ model: op.model, id: change.id, fields: change.changedFields, kind: 'upsert' });
        const after = target.readRow(change.id);
        if (after && change.changedFields !== null && change.changedFields.length > 0) accepted.push({ model: op.model, id: change.id, before: op.origin === 'replace' ? op.mergeBase as Record<string, unknown> | undefined : beforeById.get(change.id), after, origin: op.origin });
        if (after && change.changedFields === null) accepted.push({ model: op.model, id: change.id, before: beforeById.get(change.id), after, origin: op.origin });
      }
      noteRows(
        op.model,
        target,
        changes.map(change => change.id)
      );
      if (op.origin === 'replace') batch.mode = 'replace';
    }
    if (op.kind === 'patch') {
      const before = target.readRow(op.id);
      const change = target.patch(op.id, op.patch, op.operationId);
      if (change) {
        batch.rows.push({ model: op.model, id: change.id, fields: change.changedFields, kind: 'upsert' });
        const after = target.readRow(change.id);
        if (after && change.changedFields !== null && change.changedFields.length > 0) accepted.push({ model: op.model, id: change.id, before, after });
      }
      if (change) noteRows(op.model, target, [change.id]);
    }
    if (op.kind === 'destroy') {
      const before = new Map(op.ids.map(id => [id, target.readRow(id)]));
      const ids = target.destroy(op.ids, op.tombstone);
      for (const id of ids) {
        batch.rows.push({ model: op.model, id, fields: null, kind: 'destroy' });
        const row = before.get(id);
        if (row) destroyed.push({ model: op.model, id, before: row, origin: op.origin });
      }
      noteRows(op.model, target, ids);
    }
    if (op.kind === 'counter') {
      if (target.counter(op.id, op.field, op.delta, op.next)) {
        batch.rows.push({ model: op.model, id: op.id, fields: [op.field], kind: 'upsert' });
        noteRows(op.model, target, [op.id]);
      }
    }
    if (op.kind === 'scope') {
      target.scope(op.scopeKey, op.next);
      batch.scopes.push({ model: op.model, scopeKey: op.scopeKey });
      noteScope(op.model, op.scopeKey, { rebuild: true });
    }
    if (op.kind === 'scope-delta') {
      target.scopeDelta(op.scopeKey, { append: op.append, detach: op.detach });
      batch.scopes.push({ model: op.model, scopeKey: op.scopeKey });
      noteScope(op.model, op.scopeKey, {
        appendIds: op.append.map(row => row.id),
        appendEntries: op.append.filter(row => typeof row.order === 'number').map(row => ({ id: row.id, order: row.order! })),
        detachIds: op.detach
      });
    }
  }
  batch.scopeChanges = [...scopeChanges.values()];
  return { batch, accepted, destroyed };
};

const mergeBatch = (target: IncrementalCommitBatch, source: IncrementalCommitBatch): void => {
  target.rows.push(...source.rows);
  target.scopes.push(...source.scopes);
  target.scopeChanges?.push(...(source.scopeChanges ?? []));
  if (source.mode === 'replace') target.mode = 'replace';
};

const applyPlan = (ops: JournalOp[]): IncrementalCommitBatch => {
  const initial = applyOperations(ops);
  const batch = initial.batch;
  let accepted = initial.accepted;
  let destroyed = initial.destroyed;
  while (accepted.length > 0 || destroyed.length > 0) {
    const effects = deriveEffects(accepted, destroyed, ops);
    if (effects.length === 0) break;
    const phase = applyOperations(effects);
    mergeBatch(batch, phase.batch);
    accepted = phase.accepted;
    destroyed = phase.destroyed;
  }
  return batch;
};

const touchedModelsOf = (ops: JournalOp[]): string[] => uniq(ops.map(op => op.model));

const recordCounterValues = (ops: JournalOp[]): JournalOp[] => {
  const values = new Map<string, number | null>();
  return ops.map(op => {
    if (op.kind !== 'counter' || op.next !== undefined) return op;
    const key = compositeKey(op.model, op.id, op.field);
    let current = values.get(key);
    if (current === undefined) current = getApplyTarget(op.model).counterValue(op.id, op.field);
    if (current === null) return op;
    const next = current + op.delta;
    values.set(key, next);
    return { ...op, next };
  });
};

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
      entries.push({ key: `${prefix()}applied:${model}`, value: String(record.epoch) });
    }
    entries.push(...journal.committedEntry(record));
    storage.set(entries);
    for (const model of models) getApplyTarget(model).ackPersist();
  };

  const persistedAppliedEpoch = (model: string): number => {
    const raw = storage.get(`${prefix()}applied:${model}`);
    const value = raw == null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  };

  return {
    commit: envelope => {
      const ops = [...envelope.entityOps, ...envelope.scopeOps, ...envelope.identityOps, ...envelope.relationOps, ...envelope.operationOps];
      const recordedOps = recordCounterValues(ops);
      epoch += 1;
      const record: JournalRecord = { epoch, status: 'pending', ops: recordedOps };
      storage.set([...journal.pendingEntry(record), ...(envelope.extraEntries?.() ?? [])]);
      let batch: IncrementalCommitBatch;
      try {
        batch = applyPlan(recordedOps);
        syncEngineBatch(batch, getApplyTarget, true);
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
      if (checkpoint) {
        storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
        checkpoint.notePlan(touchedModelsOf(recordedOps), epoch);
      } else {
        persistImmediate(recordedOps, record);
      }
      noteCommit();
      bus.publish(batch);
      return batch;
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
          if (record.status === 'pending') storage.set(journal.committedEntry(record, checkpoint?.flushedEpoch()));
          continue;
        }
        const batch = applyPlan(ops);
        syncEngineBatch(batch, getApplyTarget);
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
