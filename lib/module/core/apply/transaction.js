"use strict";

import { createJournal } from "./journal.js";

/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to checkpoint flushes (or, on bare runtimes, to the immediate batch).
 */

const targets = new Map();

/** Register one model-owned application target for v6 plans. */
export const registerApplyTarget = (model, target) => {
  targets.set(model, target);
  return () => targets.delete(model);
};
export const getApplyTarget = model => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};
const applyOperations = (ops, setFreshness) => {
  const batch = {
    rows: [],
    scopes: []
  };
  for (const op of ops) {
    if (op.kind === 'freshness') {
      setFreshness(op.key, op.value);
      continue;
    }
    const target = getApplyTarget(op.model);
    if (op.kind === 'upsert') {
      for (const change of target.upsert(op.rows, op.origin)) batch.rows.push({
        model: op.model,
        id: change.id,
        fields: change.changedFields
      });
    }
    if (op.kind === 'patch') {
      const change = target.patch(op.id, op.patch);
      if (change) batch.rows.push({
        model: op.model,
        id: change.id,
        fields: change.changedFields
      });
    }
    if (op.kind === 'destroy') {
      for (const id of target.destroy(op.ids)) batch.rows.push({
        model: op.model,
        id,
        fields: null
      });
    }
    if (op.kind === 'counter') {
      if (target.counter(op.id, op.field, op.delta)) batch.rows.push({
        model: op.model,
        id: op.id,
        fields: [op.field]
      });
    }
    if (op.kind === 'scope') {
      target.scope(op.scopeKey, op.next);
      batch.scopes.push({
        model: op.model,
        scopeKey: op.scopeKey
      });
    }
  }
  return batch;
};
const touchedModelsOf = ops => [...new Set(ops.filter(op => op.kind !== 'freshness').map(op => op.model))];
export const createApplyRuntime = options => {
  const {
    storage,
    prefix,
    bus,
    checkpoint
  } = options;
  const setFreshness = options.setFreshness ?? (() => undefined);
  const journal = createJournal(storage, prefix);
  let epoch = journal.lastEpoch();
  const persistImmediate = (ops, record) => {
    const entries = [];
    for (const model of touchedModelsOf(ops)) {
      entries.push(...getApplyTarget(model).persistEntries());
      entries.push({
        key: `${prefix()}applied:${model}`,
        value: String(record.epoch)
      });
    }
    entries.push(...journal.committedEntry(record));
    storage.set(entries);
  };
  const persistedAppliedEpoch = model => {
    const raw = storage.get(`${prefix()}applied:${model}`);
    const value = raw == null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    apply: ops => {
      epoch += 1;
      const record = {
        epoch,
        planHash: JSON.stringify(ops),
        status: 'pending',
        ops
      };
      journal.writePending(record);
      const batch = applyOperations(ops, setFreshness);
      if (checkpoint) {
        storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
        checkpoint.notePlan(touchedModelsOf(ops), epoch);
      } else {
        persistImmediate(ops, record);
      }
      bus.publish(batch);
      return batch;
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
        const ops = record.ops.filter(op => op.kind === 'freshness' || appliedFor(op.model) < record.epoch);
        epoch = Math.max(epoch, record.epoch);
        if (ops.length === 0) continue;
        const batch = applyOperations(ops, setFreshness);
        if (checkpoint) {
          storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
          checkpoint.notePlan(touchedModelsOf(ops), record.epoch);
        } else {
          persistImmediate(ops, record);
        }
        bus.publish(batch);
        replayed += 1;
      }
      return replayed;
    },
    currentEpoch: () => epoch
  };
};
//# sourceMappingURL=transaction.js.map