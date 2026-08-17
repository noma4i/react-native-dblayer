"use strict";

import { uniq } from 'es-toolkit';
import { runInApplyBatch } from "../store.js";
import { compositeKey } from "../serialize.js";
import { getApplyTarget } from "./applyTargetRegistry.js";
const applyOperations = ops => {
  const batch = {
    rows: [],
    scopes: [],
    scopeChanges: []
  };
  const scopeChanges = new Map();
  const noteScope = (model, scopeKey, step) => {
    const key = compositeKey(model, scopeKey);
    const current = scopeChanges.get(key) ?? {
      model,
      scopeKey,
      steps: []
    };
    // A full entry set supersedes every step before it: the projection diffs it against the store.
    current.steps = 'entries' in step ? [step] : [...current.steps, step];
    scopeChanges.set(key, current);
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
    }
    if (op.kind === 'destroy') {
      const ids = target.destroy(op.ids, op.tombstone);
      for (const id of ids) {
        batch.rows.push({
          model: op.model,
          id,
          fields: null,
          kind: 'destroy',
          ...(op.replacedBy !== undefined ? {
            replacedBy: op.replacedBy
          } : {})
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
export const touchedModelsOf = ops => uniq(ops.map(op => op.model));
export const applyAtomically = (ops, commitEpoch, persist) => {
  const targets = touchedModelsOf(ops).map(model => getApplyTarget(model));
  const active = [];
  let committed = false;
  try {
    for (const target of targets) {
      target.beginApply(commitEpoch);
      active.push(target);
    }
    const batch = runInApplyBatch(() => {
      const applied = applyOperations(ops);
      persist(active);
      for (const target of active) target.commitApply();
      committed = true;
      return applied;
    });
    return batch;
  } catch (error) {
    if (!committed) {
      for (const target of active.reverse()) {
        try {
          target.abortApply();
        } catch {
          // Preserve the first transaction failure. A partially finalized target is recovered by replay.
        }
      }
    }
    throw error;
  }
};
//# sourceMappingURL=applyExecution.js.map