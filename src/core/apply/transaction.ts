import type { CommitBatch, CommitBus } from './commitBus';
import type { JournalOp, JournalRecord } from './journal';
import { createJournal } from './journal';
import type { StoragePlane } from '../planes/storagePlane';

/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to the transaction's single durable storage batch.
 */
export type ApplyTarget = {
  upsert(rows: unknown[]): Array<{ id: string; changedFields: string[] | null }>;
  patch(id: string, patch: Record<string, unknown>): { id: string; changedFields: string[] | null } | null;
  destroy(ids: string[]): string[];
  counter(id: string, field: string, delta: number): boolean;
  scope(scopeKey: string, next: unknown): void;
  persistEntries(): Array<{ key: string; value: string | null }>;
};

export type ApplyRuntime = {
  /** Apply one plan: journal pending -> in-memory apply -> single durable batch -> one commit publish. */
  apply(ops: JournalOp[]): CommitBatch;
  /** Replay incomplete epochs on startup (torn-write recovery); returns replayed epoch count. */
  replay(): number;
  currentEpoch(): number;
};

const targets = new Map<string, ApplyTarget>();

/** Register one model-owned application target for v6 plans. */
export const registerApplyTarget = (model: string, target: ApplyTarget): (() => void) => {
  targets.set(model, target);
  return () => targets.delete(model);
};

export const getApplyTarget = (model: string): ApplyTarget => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};

const applyOperations = (ops: JournalOp[], setFreshness: (key: string, value: unknown) => void): CommitBatch => {
  const batch: CommitBatch = { rows: [], scopes: [] };
  for (const op of ops) {
    if (op.kind === 'freshness') {
      setFreshness(op.key, op.value);
      continue;
    }
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      for (const change of target.upsert(op.rows)) batch.rows.push({ model: op.model, id: change.id, fields: change.changedFields });
    }
    if (op.kind === 'patch') {
      const change = target.patch(op.id, op.patch);
      if (change) batch.rows.push({ model: op.model, id: change.id, fields: change.changedFields });
    }
    if (op.kind === 'destroy') {
      for (const id of target.destroy(op.ids)) batch.rows.push({ model: op.model, id, fields: null });
    }
    if (op.kind === 'counter') {
      if (target.counter(op.id, op.field, op.delta)) batch.rows.push({ model: op.model, id: op.id, fields: [op.field] });
    }
    if (op.kind === 'scope') {
      target.scope(op.scopeKey, op.next);
      batch.scopes.push({ model: op.model, scopeKey: op.scopeKey });
    }
  }
  return batch;
};

export const createApplyRuntime = (options: {
  storage: StoragePlane;
  prefix: () => string;
  bus: CommitBus;
  setFreshness?: (key: string, value: unknown) => void;
}): ApplyRuntime => {
  const { storage, prefix, bus } = options;
  const setFreshness = options.setFreshness ?? (() => undefined);
  const journal = createJournal(storage, prefix);
  let epoch = journal.lastEpoch();

  const persistTouched = (ops: JournalOp[], record: JournalRecord): void => {
    const touchedModels = new Set(ops.filter(op => op.kind !== 'freshness').map(op => (op as { model: string }).model));
    const entries: Array<{ key: string; value: string | null }> = [];
    for (const model of touchedModels) entries.push(...getApplyTarget(model).persistEntries());
    entries.push(...journal.committedEntry(record));
    storage.set(entries);
  };

  return {
    apply: ops => {
      epoch += 1;
      const record: JournalRecord = { epoch, planHash: JSON.stringify(ops), status: 'pending', ops };
      journal.writePending(record);
      const batch = applyOperations(ops, setFreshness);
      persistTouched(ops, record);
      bus.publish(batch);
      return batch;
    },
    replay: () => {
      let replayed = 0;
      for (const record of journal.pending()) {
        const batch = applyOperations(record.ops, setFreshness);
        persistTouched(record.ops, record);
        bus.publish(batch);
        epoch = Math.max(epoch, record.epoch);
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
