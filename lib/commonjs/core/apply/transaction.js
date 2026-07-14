"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerApplyTarget = exports.getApplyTarget = exports.createApplyRuntime = void 0;
var _journal = require("./journal.js");
/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to the transaction's single durable storage batch.
 */

const targets = new Map();

/** Register one model-owned application target for v6 plans. */
const registerApplyTarget = (model, target) => {
  targets.set(model, target);
  return () => targets.delete(model);
};
exports.registerApplyTarget = registerApplyTarget;
const getApplyTarget = model => {
  const target = targets.get(model);
  if (!target) throw new Error(`No apply target registered for ${model}`);
  return target;
};
exports.getApplyTarget = getApplyTarget;
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
      for (const change of target.upsert(op.rows)) batch.rows.push({
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
const createApplyRuntime = options => {
  const {
    storage,
    prefix,
    bus
  } = options;
  const setFreshness = options.setFreshness ?? (() => undefined);
  const journal = (0, _journal.createJournal)(storage, prefix);
  let epoch = journal.lastEpoch();
  const persistTouched = (ops, record) => {
    const touchedModels = new Set(ops.filter(op => op.kind !== 'freshness').map(op => op.model));
    const entries = [];
    for (const model of touchedModels) entries.push(...getApplyTarget(model).persistEntries());
    entries.push(...journal.committedEntry(record));
    storage.set(entries);
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
exports.createApplyRuntime = createApplyRuntime;
//# sourceMappingURL=transaction.js.map