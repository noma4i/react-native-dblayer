"use strict";

/** Structural reference to a defined model; relation thunks resolve it after both models exist. */

/** Declare an inverse parent relation with optional derived parent updates (values from event data). */
export const belongsTo = (model, options) => ({
  kind: 'belongsTo',
  model: model,
  foreignKey: options.foreignKey,
  touch: options.touch,
  counterCache: options.counterCache
});

/** Declare a direct child relation whose cascade authority is explicit destroy only. */
export const hasMany = (model, options) => ({
  kind: 'hasMany',
  model: model,
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

/** Declare a query-only single child relation. */
export const hasOne = (model, options) => ({
  kind: 'hasOne',
  model: model,
  foreignKey: options.foreignKey,
  comparator: options.comparator
});

/** Declare a GC-only reference edge: ids extracted from the row keep target-model rows alive. */
export const references = (model, options) => ({
  kind: 'references',
  model: model,
  ids: options.ids
});

/**
 * Model-side capabilities the plan expander needs. Registered once per defineModel; the registry
 * survives resetRuntime the same way apply targets do - models keep working after the kill-switch.
 * Membership hooks derive declarative scope membership from ScopeSpec.by so event rows join and
 * leave their scopes in the SAME plan (same-tick visibility for optimistic/ingest rows).
 */

const hosts = new Map();
export const registerRelationHost = (modelId, host) => {
  hosts.set(modelId, host);
  return () => hosts.delete(modelId);
};

/** True when the model declares a hasMany dependent:'destroy' cascade - optimistic destroy cannot roll such a cascade back. */
export const hasDependentCascade = modelId => {
  const host = hosts.get(modelId);
  if (!host) return false;
  return Object.values(host.relations()).some(relation => relation.kind === 'hasMany' && relation.dependent === 'destroy');
};
/**
 * Expand an EVENT plan with declared relation side effects (the Rails-callbacks analog):
 * counterCache increments for first-seen children, touch projections onto parents (emitted as
 * 'patch' ops in stored format, folded per parent so several children in one plan compose),
 * dependent destroy cascades, and declarative scope membership from ScopeSpec.by. Snapshot plans
 * (query pages / entity refreshes) must NOT be expanded - server snapshots already carry derived
 * state, so defineModel routes them through the verbatim apply path. A parent upserted by the same
 * plan is authoritative: its accumulated touch is cancelled and counter ops against it are
 * filtered out.
 */
export const expandPlan = ops => {
  const queue = [...ops];
  const out = [];
  const authoritative = new Set();
  const counted = new Map();
  const destroyed = new Set();
  const touched = new Set();
  const touchViews = new Map();
  const membership = new Map();
  const accumulateMembership = (model, deltas) => {
    for (const delta of deltas) {
      const key = `${model}:${delta.scopeKey}`;
      let entry = membership.get(key);
      if (!entry) {
        entry = {
          model,
          scopeKey: delta.scopeKey,
          append: new Set(),
          detach: new Set()
        };
        membership.set(key, entry);
      }
      for (const id of delta.append ?? []) {
        entry.append.add(id);
        entry.detach.delete(id);
      }
      for (const id of delta.detach ?? []) {
        entry.detach.add(id);
        entry.append.delete(id);
      }
    }
  };
  const parentIdOf = (row, foreignKey) => {
    const value = row[foreignKey];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const countKeyOf = (modelId, childId, counter) => `${modelId}:${childId}:${counter.model}:${counter.field}`;
  const accumulateTouch = (relation, child, parentId) => {
    const parentKey = `${relation.model.modelId}:${parentId}`;
    if (!relation.touch || authoritative.has(parentKey) || touched.has(parentKey)) return;
    let entry = touchViews.get(parentKey);
    if (!entry) {
      const parent = relation.model.get(parentId);
      if (!parent) return;
      entry = {
        model: relation.model.modelId,
        id: parentId,
        view: {
          ...parent
        },
        patch: {}
      };
      touchViews.set(parentKey, entry);
    }
    const patch = relation.touch(child, entry.view);
    if (patch) {
      Object.assign(entry.view, patch);
      Object.assign(entry.patch, patch);
    }
  };
  const upsertEffects = (modelId, host, row) => {
    const childId = String(row.id);
    for (const relation of Object.values(host.relations())) {
      if (relation.kind !== 'belongsTo') continue;
      const parentId = parentIdOf(row, relation.foreignKey);
      if (!parentId) continue;
      if (relation.counterCache && !host.has(childId) && (relation.counterCache.filter?.(row) ?? true)) {
        const counter = {
          model: relation.model.modelId,
          id: parentId,
          field: relation.counterCache.field
        };
        const countKey = countKeyOf(modelId, childId, counter);
        if (!counted.has(countKey)) {
          counted.set(countKey, counter);
          queue.push({
            kind: 'counter',
            model: counter.model,
            id: counter.id,
            field: counter.field,
            delta: 1
          });
        }
      }
      accumulateTouch(relation, row, parentId);
    }
  };
  const patchEffects = (modelId, id, patch) => {
    const host = hosts.get(modelId);
    if (!host) return;
    const current = host.read(id);
    if (!current) return;
    const merged = {
      ...current,
      ...patch,
      id
    };
    for (const relation of Object.values(host.relations())) {
      if (relation.kind !== 'belongsTo') continue;
      const parentId = parentIdOf(merged, relation.foreignKey);
      if (parentId) accumulateTouch(relation, merged, parentId);
    }
  };
  const destroyEffects = (modelId, id) => {
    const destroyKey = `${modelId}:${id}`;
    if (destroyed.has(destroyKey)) return;
    destroyed.add(destroyKey);
    const host = hosts.get(modelId);
    if (!host) return;
    const row = host.read(id);
    for (const relation of Object.values(host.relations())) {
      if (relation.kind === 'belongsTo' && relation.counterCache) {
        const parentId = row ? parentIdOf(row, relation.foreignKey) : null;
        const counter = parentId ? {
          model: relation.model.modelId,
          id: parentId,
          field: relation.counterCache.field
        } : null;
        const pendingKey = counter ? countKeyOf(modelId, id, counter) : null;
        const pending = pendingKey ? counted.get(pendingKey) : undefined;
        if (pending && pendingKey) {
          counted.delete(pendingKey);
          queue.push({
            kind: 'counter',
            model: pending.model,
            id: pending.id,
            field: pending.field,
            delta: -1
          });
        } else if (row && counter && (relation.counterCache.filter?.(row) ?? true)) {
          queue.push({
            kind: 'counter',
            model: counter.model,
            id: counter.id,
            field: counter.field,
            delta: -1
          });
        }
      }
      if (relation.kind === 'hasMany' && relation.dependent === 'destroy') {
        const ids = relation.model.getWhere({
          [relation.foreignKey]: id
        }).map(child => String(child.id)).filter(childId => !destroyed.has(`${relation.model.modelId}:${childId}`));
        if (ids.length > 0) queue.push({
          kind: 'destroy',
          model: relation.model.modelId,
          ids
        });
      }
    }
  };
  while (queue.length > 0 || touchViews.size > 0) {
    while (queue.length > 0) {
      const op = queue.shift();
      out.push(op);
      if (op.kind === 'upsert') {
        const host = hosts.get(op.model);
        for (const raw of op.rows) {
          const row = host?.normalize(raw);
          if (!host || !row) continue;
          upsertEffects(op.model, host, row);
          accumulateMembership(op.model, host.membershipForUpsert(row));
          const key = `${op.model}:${String(row.id)}`;
          authoritative.add(key);
          touchViews.delete(key);
        }
      }
      if (op.kind === 'patch') {
        patchEffects(op.model, op.id, op.patch);
        accumulateMembership(op.model, hosts.get(op.model)?.membershipForPatch(op.id, op.patch) ?? []);
      }
      if (op.kind === 'destroy') {
        for (const id of op.ids) {
          accumulateMembership(op.model, hosts.get(op.model)?.detachForDestroy(id) ?? []);
          destroyEffects(op.model, id);
        }
      }
    }
    const flush = [...touchViews.values()];
    touchViews.clear();
    for (const entry of flush) {
      const key = `${entry.model}:${entry.id}`;
      if (touched.has(key) || Object.keys(entry.patch).length === 0) continue;
      touched.add(key);
      queue.push({
        kind: 'patch',
        model: entry.model,
        id: entry.id,
        patch: entry.patch
      });
    }
  }
  for (const entry of membership.values()) {
    if (entry.append.size === 0 && entry.detach.size === 0) continue;
    out.push({
      kind: 'scope-delta',
      model: entry.model,
      scopeKey: entry.scopeKey,
      append: [...entry.append].map(id => ({
        id
      })),
      detach: [...entry.detach]
    });
  }
  return out.filter(op => !(op.kind === 'counter' && authoritative.has(`${op.model}:${op.id}`)));
};
//# sourceMappingURL=relations.js.map