"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.registerRelationTarget = exports.registerRelationHost = exports.references = exports.readModelRelation = exports.modelRef = exports.hasOne = exports.hasMany = exports.hasDependentCascade = exports.deriveEffects = exports.belongsTo = void 0;
var _esToolkit = require("es-toolkit");
var _serialize = require("./serialize.js");
var _generationRegistry = require("./generationRegistry.js");
var _diagnostics = require("./diagnostics.js");
var _ordering = require("./ordering.js");
/**
 * Declare an inverse parent relation (child -> parent) with optional derived parent updates from event data.
 * Resolved by `deriveEffects`, which accumulates `touch` patches per parent (folding several children in one
 * plan) and `counterCache` increments/decrements before WAL, emitting them as extra `patch`/`counter` intents
 * in the same compiled plan as the triggering event.
 *
 * @param model The parent model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.touch Derive a partial parent update from the child and current parent view; return `null`
 * to skip. Runs once per parent per plan even if several children touch it (last patch per field wins).
 * Only applies to EVENT plans - snapshot writes (queries, entity refreshes) are not expanded.
 * @param options.counterCache Increment `field` on the parent when a NEW child first references it, decrement
 * on child destroy (or on an uncommitted increment being cancelled within the same plan); `filter` restricts
 * which children count.
 * @returns A belongsTo relation declaration for a parent-model edge.
 */
const belongsTo = (model, options) => ({
  kind: 'belongsTo',
  model: toModelRef(model),
  foreignKey: options.foreignKey,
  touch: options.touch,
  counterCache: options.counterCache
});

/**
 * Declare a direct child relation (parent -> children) whose cascade authority is explicit destroy only.
 * `deriveEffects` reads children through the immutable plan snapshot so a cascade sees children written
 * earlier in the same plan without applying any row first.
 *
 * @param model The child model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.dependent `'destroy'` cascades a parent destroy to its live children in the same plan.
 * Omit for a query-only relation with no cascade. Optimistic destroy on the parent throws if this is set,
 * since a cascaded destroy cannot be rolled back.
 * @returns A hasMany relation declaration for a child-collection edge.
 */
exports.belongsTo = belongsTo;
const hasMany = (model, options) => ({
  kind: 'hasMany',
  model: toModelRef(model),
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

/**
 * Declare a query-only single child relation (parent -> one child), read through `model.related(id, name)`.
 * Not resolved by `deriveEffects` - it has no write-time side effects, only a reactive query.
 *
 * @param model The child model reference.
 * @param options.foreignKey Child field storing the parent id.
 * @param options.comparator Pick the "one" child when several match; the lowest-sorting row wins. Omit to
 * use the first match in read order.
 * @returns A hasOne relation declaration for a single-child edge.
 */
exports.hasMany = hasMany;
const hasOne = (model, options) => ({
  kind: 'hasOne',
  model: toModelRef(model),
  foreignKey: options.foreignKey,
  comparator: options.comparator
});

/**
 * Declare a GC-only reference edge: ids extracted from the row keep the referenced target-model rows alive
 * during garbage-collection sweeps. Not resolved by `deriveEffects` - it has no write-time side effects, only
 * a GC liveness signal (see `referencesOf` in the model's GC host registration).
 *
 * @param model The referenced model.
 * @param options.ids Extract the referenced id(s) from the row; a single id, an array, or nullish (no reference).
 * @returns A references relation declaration for GC liveness edges.
 */
exports.hasOne = hasOne;
const references = (model, options) => ({
  kind: 'references',
  model: toModelRef(model),
  ids: options.ids
});

/**
 * Model-side capabilities the plan expander needs. Registered once per defineModel; the registry
 * survives resetRuntime the same way apply targets do - models keep working after the kill-switch.
 * Membership hooks derive declarative scope membership from ScopeSpec.by so event rows join and
 * leave their scopes in the SAME plan (same-tick visibility for optimistic/ingest rows).
 */
exports.references = references;
const hosts = (0, _generationRegistry.createGenerationRegistry)();
const facadeTargets = new Map();
const registerRelationTarget = (key, target) => {
  facadeTargets.set(key, target);
};

/**
 * Creates a deferred, typed association target for a model identified by its persisted key.
 * Use this target when direct facade references would form a circular module or type dependency.
 *
 * @param key The target model key passed to `defineModel`.
 * @returns A model reference resolved when an association reads or plans a write.
 */
exports.registerRelationTarget = registerRelationTarget;
const modelRef = key => {
  const resolve = () => {
    const target = facadeTargets.get(key);
    if (!target) throw new Error(`No model registered for ${key}`);
    return target;
  };
  return {
    modelId: key,
    find: id => resolve().find(id),
    all: () => resolve().where({}).read(),
    where: where => resolve().where(where).read()
  };
};
exports.modelRef = modelRef;
const registerRelationHost = (modelId, host) => {
  return hosts.register(modelId, host, `Relation host already registered for model ${modelId}`);
};

/**
 * Read one declared association through the same registered relation graph used by write effects.
 *
 * @param modelId Source model key.
 * @param id Source row id.
 * @param name Association name.
 * @returns One target row, an ordered target row list, or undefined.
 */
exports.registerRelationHost = registerRelationHost;
const readModelRelation = (modelId, id, name) => {
  const host = hosts.get(modelId);
  const relation = host?.relations()[name];
  if (!host || !relation) throw new Error(`${modelId} has no association ${name}`);
  if (id == null) return relation.kind === 'hasMany' || relation.kind === 'references' ? [] : undefined;
  const source = host.read(String(id));
  if (!source) return relation.kind === 'hasMany' || relation.kind === 'references' ? [] : undefined;
  if (relation.kind === 'belongsTo') {
    const targetId = source[relation.foreignKey];
    return typeof targetId === 'string' ? relation.model.find(targetId) : undefined;
  }
  if (relation.kind === 'hasMany') return relation.model.where({
    [relation.foreignKey]: String(id)
  });
  if (relation.kind === 'hasOne') {
    const rows = relation.model.where({
      [relation.foreignKey]: String(id)
    });
    if (rows.length === 0) return undefined;
    const comparator = relation.comparator ? (0, _ordering.withIdTieBreak)(relation.comparator) : undefined;
    return comparator ? rows.reduce((best, row) => comparator(row, best) < 0 ? row : best) : rows[0];
  }
  const selected = relation.ids(source);
  const ids = Array.isArray(selected) ? selected : [selected];
  return ids.flatMap(targetId => {
    const row = targetId == null ? undefined : relation.model.find(String(targetId));
    return row ? [row] : [];
  });
};

/** True when the model declares a hasMany dependent:'destroy' cascade - optimistic destroy cannot roll such a cascade back. */
exports.readModelRelation = readModelRelation;
const hasDependentCascade = modelId => {
  const host = hosts.get(modelId);
  if (!host) return false;
  return Object.values(host.relations()).some(relation => relation.kind === 'hasMany' && relation.dependent === 'destroy');
};

/**
 * Derive relation effects from rows accepted by pure write previews. The returned intents are compiled
 * into callback-free journal operations before WAL; replay never invokes relation callbacks.
 */
exports.hasDependentCascade = hasDependentCascade;
const deriveEffects = (accepted, destroyedRows, rawOps, reader) => {
  const queue = [];
  const out = [];
  const authoritative = new Set(accepted.filter(row => row.origin !== undefined).map(row => (0, _serialize.compositeKey)(row.model, row.id)));
  const counted = new Map();
  const destroyed = new Set();
  const touched = new Set();
  const touchViews = new Map();
  const membership = new Map();
  const explicitScopeModels = new Set(rawOps.filter(op => op.kind === 'scope').map(op => op.model));
  const accumulateMembership = (model, deltas) => {
    for (const delta of deltas) {
      const key = (0, _serialize.compositeKey)(model, delta.scopeKey);
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
  const detachAccumulatedMembership = (model, id) => {
    for (const entry of membership.values()) {
      if (entry.model !== model || !entry.append.has(id)) continue;
      entry.append.delete(id);
      entry.detach.add(id);
    }
  };
  const parentIdOf = (row, foreignKey) => {
    const value = row[foreignKey];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const countKeyOf = (modelId, childId, counter) => (0, _serialize.compositeKey)(modelId, childId, counter.model, counter.field);
  const accumulateTouch = (relation, child, parentId) => {
    const parentKey = (0, _serialize.compositeKey)(relation.model.modelId, parentId);
    if (!relation.touch || authoritative.has(parentKey) || touched.has(parentKey)) return;
    let entry = touchViews.get(parentKey);
    if (!entry) {
      const parent = reader.read(relation.model.modelId, parentId);
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

  /**
   * Relation effect origin matrix:
   *
   * | operation | counter cache | touch | dependent destroy |
   * | --- | --- | --- | --- |
   * | event | +1 | yes | none |
   * | snapshot | none | none | none |
   * | replace | none | none | none |
   * | patch | none | none | none |
   * | ordinary destroy | -1 | none | cascade |
   * | replace destroy | none | none | none |
   *
   * Effects model logical existence: snapshots are authoritative and identity swaps do not create or remove a record.
   */
  const upsertEffects = (modelId, host, row, existed) => {
    const childId = String(row.id);
    for (const relation of Object.values(host.relations())) {
      if (relation.kind !== 'belongsTo') continue;
      const parentId = parentIdOf(row, relation.foreignKey);
      if (!parentId) continue;
      if (relation.counterCache && !existed && (relation.counterCache.filter?.(row) ?? true)) {
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

  /** Plan-local lazy FK index: one child-model scan per (model, foreignKey) per plan instead of one per destroyed parent. */
  const childFkIndexes = new Map();
  const childrenByForeignKey = (childModelId, foreignKey) => {
    const indexKey = (0, _serialize.compositeKey)(childModelId, foreignKey);
    const existing = childFkIndexes.get(indexKey);
    if (existing) return existing;
    (0, _diagnostics.noteRelationChildScan)();
    const index = new Map();
    for (const child of reader.rows(childModelId)) {
      const parentId = child[foreignKey];
      if (typeof parentId !== 'string' || parentId.length === 0) continue;
      let bucket = index.get(parentId);
      if (!bucket) {
        bucket = [];
        index.set(parentId, bucket);
      }
      bucket.push(String(child.id));
    }
    childFkIndexes.set(indexKey, index);
    return index;
  };

  /** Ordinary-destroy branch of the relation effect origin matrix above. */
  const destroyEffects = (modelId, id, row) => {
    const destroyKey = (0, _serialize.compositeKey)(modelId, id);
    if (destroyed.has(destroyKey)) return;
    destroyed.add(destroyKey);
    const host = hosts.get(modelId);
    if (!host) return;
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
        const ids = (0, _esToolkit.uniq)(childrenByForeignKey(relation.model.modelId, relation.foreignKey).get(id) ?? []).filter(childId => !destroyed.has((0, _serialize.compositeKey)(relation.model.modelId, childId)));
        if (ids.length > 0) queue.push({
          kind: 'destroy',
          model: relation.model.modelId,
          ids
        });
      }
    }
  };
  for (const acceptedRow of accepted) {
    const host = hosts.get(acceptedRow.model);
    if (!host) continue;
    if (!explicitScopeModels.has(acceptedRow.model)) {
      accumulateMembership(acceptedRow.model, host.membershipForUpsert(acceptedRow.before, acceptedRow.after));
    }
    if (acceptedRow.origin === 'event') {
      upsertEffects(acceptedRow.model, host, acceptedRow.after, acceptedRow.before !== undefined);
    }
  }
  for (const destroyedRow of destroyedRows) {
    accumulateMembership(destroyedRow.model, hosts.get(destroyedRow.model)?.detachForDestroy(destroyedRow.id) ?? []);
    detachAccumulatedMembership(destroyedRow.model, destroyedRow.id);
    if (destroyedRow.origin !== 'replace') destroyEffects(destroyedRow.model, destroyedRow.id, destroyedRow.before);
  }
  while (queue.length > 0 || touchViews.size > 0) {
    while (queue.length > 0) {
      const op = queue.shift();
      out.push(op);
    }
    const flush = [...touchViews.values()];
    touchViews.clear();
    for (const entry of flush) {
      const key = (0, _serialize.compositeKey)(entry.model, entry.id);
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
  const placementIds = new Map();
  for (const op of rawOps) {
    if (op.kind !== 'scope-delta') continue;
    const ids = placementIds.get((0, _serialize.compositeKey)(op.model, op.scopeKey)) ?? new Set();
    for (const row of op.append) if (row.orderKey !== undefined) ids.add(row.id);
    placementIds.set((0, _serialize.compositeKey)(op.model, op.scopeKey), ids);
  }
  return [...out, ...[...membership.values()].flatMap(entry => {
    if (entry.append.size === 0 && entry.detach.size === 0) return [];
    const placement = placementIds.get((0, _serialize.compositeKey)(entry.model, entry.scopeKey));
    const append = [...entry.append].filter(id => !placement?.has(id)).map(id => ({
      id
    }));
    return append.length > 0 || entry.detach.size > 0 ? [{
      kind: 'scope-delta',
      model: entry.model,
      scopeKey: entry.scopeKey,
      append,
      detach: [...entry.detach]
    }] : [];
  })].filter(op => !(op.kind === 'counter' && authoritative.has((0, _serialize.compositeKey)(op.model, op.id))));
};
exports.deriveEffects = deriveEffects;
const toModelRef = model => {
  if ('modelId' in model) return model;
  return {
    modelId: model.key,
    find: model.find,
    all: () => model.where({}).read(),
    where: where => model.where(where).read()
  };
};
//# sourceMappingURL=relations.js.map