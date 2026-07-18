"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerApplyTarget = exports.getApplyTarget = exports.createApplyRuntime = void 0;
var _journal = require("./journal.js");
var _esToolkit = require("es-toolkit");
/**
 * Model-owned application target. `upsert`/`destroy` report per-row change granularity so the
 * commit bus can notify per-(model, id, field) subscribers; `persistEntries` contributes the
 * model's dirty state to checkpoint flushes (or, on bare runtimes, to the immediate batch).
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
const applyOperations = ops => {
  const batch = {
    rows: [],
    scopes: [],
    mode: 'delta',
    scopeChanges: []
  };
  const scopeChanges = new Map();
  const noteScope = (model, scopeKey, change) => {
    const key = `${model}:${scopeKey}`;
    const current = scopeChanges.get(key) ?? {
      model,
      scopeKey
    };
    const mergeIds = (left, right) => left || right ? (0, _esToolkit.uniq)([...(left ?? []), ...(right ?? [])]) : undefined;
    const mergeAppendEntries = (left, right) => {
      if (!left && !right) return undefined;
      return (0, _esToolkit.uniqBy)([...(right ?? []), ...(left ?? [])], entry => entry.id);
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
      const changes = target.upsert(op.rows, op.origin);
      for (const change of changes) batch.rows.push({
        model: op.model,
        id: change.id,
        fields: change.changedFields
      });
      noteRows(op.model, target, changes.map(change => change.id));
      if (op.origin === 'replace') batch.mode = 'replace';
    }
    if (op.kind === 'patch') {
      const change = target.patch(op.id, op.patch);
      if (change) batch.rows.push({
        model: op.model,
        id: change.id,
        fields: change.changedFields
      });
      if (change) noteRows(op.model, target, [change.id]);
    }
    if (op.kind === 'destroy') {
      const ids = target.destroy(op.ids, op.tombstone);
      for (const id of ids) batch.rows.push({
        model: op.model,
        id,
        fields: null
      });
      noteRows(op.model, target, ids);
    }
    if (op.kind === 'counter') {
      if (target.counter(op.id, op.field, op.delta, op.next)) {
        batch.rows.push({
          model: op.model,
          id: op.id,
          fields: [op.field]
        });
        noteRows(op.model, target, [op.id]);
      }
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
const touchedModelsOf = ops => [...new Set(ops.map(op => op.model))];
const recordCounterValues = ops => {
  const values = new Map();
  return ops.map(op => {
    if (op.kind !== 'counter' || op.next !== undefined) return op;
    const key = `${op.model}:${op.id}:${op.field}`;
    let current = values.get(key);
    if (current === undefined) current = getApplyTarget(op.model).counterValue(op.id, op.field);
    if (current === null) return op;
    const next = current + op.delta;
    values.set(key, next);
    return {
      ...op,
      next
    };
  });
};
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
      const recordedOps = recordCounterValues(ops);
      epoch += 1;
      const record = {
        epoch,
        status: 'pending',
        ops: recordedOps
      };
      journal.writePending(record);
      const batch = applyOperations(recordedOps);
      if (checkpoint) {
        storage.set(journal.committedEntry(record, checkpoint.flushedEpoch()));
        checkpoint.notePlan(touchedModelsOf(recordedOps), epoch);
      } else {
        persistImmediate(recordedOps, record);
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
        const ops = record.ops.filter(op => appliedFor(op.model) < record.epoch);
        epoch = Math.max(epoch, record.epoch);
        if (ops.length === 0) {
          if (record.status === 'pending') storage.set(journal.committedEntry(record, checkpoint?.flushedEpoch()));
          continue;
        }
        const batch = applyOperations(ops);
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
exports.createApplyRuntime = createApplyRuntime;
//# sourceMappingURL=transaction.js.map