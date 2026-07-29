"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.touchedModelsOf = exports.applyAtomically = void 0;
var _esToolkit = require("es-toolkit");
var _store = require("../store.js");
var _serialize = require("../serialize.js");
var _applyTargetRegistry = require("./applyTargetRegistry.js");
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
    const target = (0, _applyTargetRegistry.getApplyTarget)(op.model);
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
exports.touchedModelsOf = touchedModelsOf;
const applyAtomically = ops => {
  const targets = touchedModelsOf(ops).map(model => (0, _applyTargetRegistry.getApplyTarget)(model));
  const active = [];
  try {
    for (const target of targets) {
      target.beginApply();
      active.push(target);
    }
    const batch = (0, _store.runInApplyBatch)(() => applyOperations(ops));
    for (const target of active) target.commitApply();
    return batch;
  } catch (error) {
    for (const target of active.reverse()) target.abortApply();
    throw error;
  }
};
exports.applyAtomically = applyAtomically;
//# sourceMappingURL=applyExecution.js.map