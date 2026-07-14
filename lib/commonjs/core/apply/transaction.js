"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerApplyTarget = exports.createApplyRuntime = void 0;
var _journal = require("./journal.js");
const targets = new Map();

/** Register one model-owned application target for v6 plans. */
const registerApplyTarget = (model, target) => {
  targets.set(model, target);
  return () => targets.delete(model);
};
exports.registerApplyTarget = registerApplyTarget;
const applyOperations = ops => {
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
const createApplyRuntime = (storage, prefix) => {
  const journal = (0, _journal.createJournal)(storage, prefix);
  let epoch = 0;
  const commit = record => {
    journal.writePending(record);
    applyOperations(record.ops);
    journal.markCommitted(record);
  };
  return {
    apply: ops => {
      epoch += 1;
      commit({
        epoch,
        planHash: JSON.stringify(ops),
        status: 'pending',
        ops
      });
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
exports.createApplyRuntime = createApplyRuntime;
//# sourceMappingURL=transaction.js.map