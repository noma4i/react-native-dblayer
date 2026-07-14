import type { JournalOp, JournalRecord } from './journal';
import { createJournal } from './journal';
import type { StoragePlane } from '../planes/storagePlane';

export type ApplyTarget = {
  upsert(rows: unknown[]): void;
  destroy(ids: string[]): void;
  counter(id: string, field: string, delta: number): void;
  scope(scopeHash: string, next: unknown): void;
};

export type ApplyRuntime = {
  apply(ops: JournalOp[]): void;
  replay(): void;
};

const targets = new Map<string, ApplyTarget>();

/** Register one model-owned application target for v6 plans. */
export const registerApplyTarget = (model: string, target: ApplyTarget): (() => void) => {
  targets.set(model, target);
  return () => targets.delete(model);
};

const applyOperations = (ops: JournalOp[]): void => {
  for (const op of ops) {
    if (op.kind === 'freshness') continue;
    const target = targets.get(op.model);
    if (!target) throw new Error(`No apply target registered for ${op.model}`);
    if (op.kind === 'upsert') target.upsert(op.rows);
    if (op.kind === 'destroy') target.destroy(op.ids);
    if (op.kind === 'counter') target.counter(op.id, op.field, op.delta);
    if (op.kind === 'scope') target.scope(op.scopeHash, op.next);
  }
};

/** Apply each plan once in memory, with a durable pending record before persistence flushes. */
export const createApplyRuntime = (storage: StoragePlane, prefix: string): ApplyRuntime => {
  const journal = createJournal(storage, prefix);
  let epoch = 0;

  const commit = (record: JournalRecord): void => {
    journal.writePending(record);
    applyOperations(record.ops);
    journal.markCommitted(record);
  };

  return {
    apply: ops => {
      epoch += 1;
      commit({ epoch, planHash: JSON.stringify(ops), status: 'pending', ops });
    },
    replay: () => {
      for (const record of journal.pending()) {
        applyOperations(record.ops);
        journal.markCommitted(record);
        epoch = Math.max(epoch, record.epoch);
      }
    }
  };
};
