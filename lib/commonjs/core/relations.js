"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.touchBelongsToParents = exports.relationValues = exports.registerCascadeController = exports.propagateBelongsToParents = exports.hasOne = exports.hasManyThrough = exports.hasMany = exports.getCascadeController = exports.buildRelatedAccessors = exports.belongsTo = exports.attachRowRelated = void 0;
var _db = require("@tanstack/db");
var _reactDb = require("@tanstack/react-db");
var _react = require("react");
var _shared = require("../queries/base/shared.js");
var _pickDefined = require("../utils/pickDefined.js");
var _typeBoundary = require("../utils/typeBoundary.js");
const EMPTY = Object.freeze([]);
const cascadeControllers = new WeakMap();
const rowRelatedRecords = new WeakMap();
let touchDepth = 0;
const registerCascadeController = (model, controller) => {
  cascadeControllers.set(model, controller);
};
exports.registerCascadeController = registerCascadeController;
const getCascadeController = model => {
  if (typeof model !== 'object' && typeof model !== 'function' || model === null) return undefined;
  return cascadeControllers.get(model);
};

/**
 * Declare a direct child collection relation.
 *
 * @param model Child model whose stored rows contain the parent foreign key.
 * @param options Foreign-key field and optional dependent action.
 * @returns Relation metadata used for related accessors and cascade destroy.
 */
exports.getCascadeController = getCascadeController;
const hasMany = (model, options) => ({
  kind: 'hasMany',
  model,
  foreignKey: options.foreignKey,
  dependent: options.dependent
});

/**
 * Declare a query-only single child relation.
 *
 * The relation does not participate in cascade destroy. The required comparator orders matching child
 * rows inside the parent scope, and the first row is exposed through snapshot, hook, and row-chain reads.
 *
 * @param model Child model whose stored rows contain the parent foreign key.
 * @param options Foreign-key field and required child-row comparator.
 * @returns Relation metadata used for related accessors.
 */
exports.hasMany = hasMany;
const hasOne = (model, options) => ({
  kind: 'hasOne',
  model,
  foreignKey: options.foreignKey,
  comparator: options.comparator
});

/**
 * Declare a query-only relation through another direct hasMany relation.
 *
 * @param options Names of the through relation and the source relation on through rows.
 * @returns Relation metadata used for composed related accessors.
 */
exports.hasOne = hasOne;
const hasManyThrough = options => ({
  kind: 'hasManyThrough',
  through: options.through,
  source: options.source
});

/**
 * Declare an inverse parent relation from a child row foreign key.
 *
 * @param model Parent model read by the child foreign key.
 * @param options Foreign-key field, optional local-only timestamp touch, and optional full-path parent propagation.
 * @returns Relation metadata used for parent related accessors.
 */
exports.hasManyThrough = hasManyThrough;
const belongsTo = (model, options) => ({
  kind: 'belongsTo',
  model,
  foreignKey: options.foreignKey,
  touch: options.touch === true,
  ...(options.propagate ? {
    propagate: options.propagate
  } : {})
});
exports.belongsTo = belongsTo;
const relationValues = relations => {
  if (!relations) return [];
  return Object.values(relations);
};
exports.relationValues = relationValues;
const isHasManyRelation = relation => relation?.kind === 'hasMany';
const isHasOneRelation = relation => relation?.kind === 'hasOne';
const isBelongsToRelation = relation => relation?.kind === 'belongsTo';
const assertDirectRelation = (modelName, relationName, relation, detail) => {
  if (isHasManyRelation(relation)) return relation;
  throw new Error(`[${modelName}] relation "${relationName}" ${detail}`);
};
const attachRowsForRelation = (relation, rows) => {
  const output = rows;
  if (output.length === 0) return output;
  const controller = getCascadeController(relation.model);
  if (!controller) return output;
  for (const row of output) {
    controller.attachRowRelated(row);
  }
  return output;
};
const useRowsByForeignKey = (relation, parentId) => {
  const foreignKey = relation.foreignKey;
  const {
    data
  } = (0, _reactDb.useLiveQuery)(q => parentId == null ? undefined : q.from({
    items: relation.model.collection
  }).where(({
    items
  }) => (0, _db.eq)((0, _typeBoundary.toQueryValue)(items[foreignKey]), parentId)), [foreignKey, parentId]);
  return (0, _shared.useStableArray)(attachRowsForRelation(relation, parentId == null ? EMPTY : data ?? EMPTY));
};
const useCountByForeignKey = (relation, parentId) => {
  const foreignKey = relation.foreignKey;
  const {
    data
  } = (0, _reactDb.useLiveQuery)(q => parentId == null ? undefined : q.from({
    items: relation.model.collection
  }).where(({
    items
  }) => (0, _db.eq)((0, _typeBoundary.toQueryValue)(items[foreignKey]), parentId)).groupBy(() => 1).select(({
    items
  }) => ({
    total: (0, _db.count)((0, _typeBoundary.toQueryValue)(items.id))
  })), [foreignKey, parentId]);
  return parentId == null ? 0 : data?.[0]?.total ?? 0;
};
const getRowsByForeignKey = (relation, parentId) => {
  if (parentId == null) return [];
  return attachRowsForRelation(relation, relation.model.getWhere({
    [relation.foreignKey]: parentId
  }));
};
const pickFirstRelatedRow = (rows, comparator) => {
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return rows[0];
  return [...rows].sort(comparator)[0];
};
const useRowsByForeignKeySet = (relation, parentIds) => {
  const foreignKey = relation.foreignKey;
  const parentIdsKey = (0, _react.useMemo)(() => parentIds.join('\u0000'), [parentIds]);
  const {
    data
  } = (0, _reactDb.useLiveQuery)(q => parentIds.length === 0 ? undefined : q.from({
    items: relation.model.collection
  }).where(({
    items
  }) => (0, _db.inArray)((0, _typeBoundary.toQueryValue)(items[foreignKey]), parentIds)), [foreignKey, parentIdsKey]);
  return (0, _shared.useStableArray)(attachRowsForRelation(relation, parentIds.length === 0 ? EMPTY : data ?? EMPTY));
};
const getRowsByForeignKeySet = (relation, parentIds) => {
  if (parentIds.length === 0) return [];
  return attachRowsForRelation(relation, relation.model.getWhere({
    or: parentIds.map(parentId => ({
      [relation.foreignKey]: parentId
    }))
  }));
};
const readParentId = (row, foreignKey) => {
  const value = row ? row[foreignKey] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
const getParentRow = (relation, childRow) => {
  const parentId = readParentId(childRow, relation.foreignKey);
  return parentId ? relation.model.get(parentId) : undefined;
};
const useChildRowById = (context, childId) => {
  const {
    data
  } = (0, _reactDb.useLiveQuery)(q => childId == null ? undefined : q.from({
    items: context.collection
  }).where(({
    items
  }) => (0, _db.eq)((0, _typeBoundary.toQueryValue)(items.id), childId)).findOne(), [childId]);
  return data;
};
const resolveThroughRelations = (modelName, relationName, relation, relations) => {
  const throughRelation = assertDirectRelation(modelName, relationName, relations[relation.through], `hasManyThrough through "${relation.through}" must point to a direct hasMany relation.`);
  const throughController = getCascadeController(throughRelation.model);
  const sourceRelation = assertDirectRelation(modelName, relationName, throughController?.getRelation(relation.source), `hasManyThrough source "${relation.source}" must point to a direct hasMany relation on the through model.`);
  return {
    throughRelation,
    sourceRelation
  };
};
const createDirectAccessor = relation => ({
  get: parentId => getRowsByForeignKey(relation, parentId),
  use: parentId => useRowsByForeignKey(relation, parentId),
  count: parentId => useCountByForeignKey(relation, parentId)
});
const createHasOneAccessor = relation => ({
  get: parentId => pickFirstRelatedRow(getRowsByForeignKey(relation, parentId), relation.comparator),
  use(parentId) {
    const rows = useRowsByForeignKey(relation, parentId);
    return (0, _react.useMemo)(() => pickFirstRelatedRow(rows, relation.comparator), [rows, relation]);
  }
});
const createThroughAccessor = (modelName, relationName, relation, resolveRelations) => ({
  get(parentId) {
    const {
      throughRelation,
      sourceRelation
    } = resolveThroughRelations(modelName, relationName, relation, resolveRelations());
    const throughIds = getRowsByForeignKey(throughRelation, parentId).map(row => row.id);
    return getRowsByForeignKeySet(sourceRelation, throughIds);
  },
  use(parentId) {
    const {
      throughRelation,
      sourceRelation
    } = resolveThroughRelations(modelName, relationName, relation, resolveRelations());
    const throughRows = useRowsByForeignKey(throughRelation, parentId);
    const throughIds = (0, _react.useMemo)(() => throughRows.map(row => row.id), [throughRows]);
    return useRowsByForeignKeySet(sourceRelation, throughIds);
  },
  count(parentId) {
    const {
      throughRelation,
      sourceRelation
    } = resolveThroughRelations(modelName, relationName, relation, resolveRelations());
    const throughRows = useRowsByForeignKey(throughRelation, parentId);
    const throughIds = (0, _react.useMemo)(() => throughRows.map(row => row.id), [throughRows]);
    return useRowsByForeignKeySet(sourceRelation, throughIds).length;
  }
});
const createBelongsToAccessor = (relation, context) => ({
  get(childId) {
    if (childId == null) return undefined;
    return getParentRow(relation, context.getRow(childId));
  },
  use(childId) {
    const childRow = useChildRowById(context, childId);
    const parentId = readParentId(childRow, relation.foreignKey);
    return relation.model.find(parentId);
  }
});
const buildRelatedAccessors = (modelName, resolveRelations, context) => {
  const relations = resolveRelations();
  const related = {};
  for (const [relationName, relation] of Object.entries(relations)) {
    if (isBelongsToRelation(relation)) {
      related[relationName] = createBelongsToAccessor(relation, context);
      continue;
    }
    if (isHasManyRelation(relation)) {
      related[relationName] = createDirectAccessor(relation);
      continue;
    }
    if (isHasOneRelation(relation)) {
      related[relationName] = createHasOneAccessor(relation);
      continue;
    }
    if (relation.kind === 'hasManyThrough') {
      related[relationName] = createThroughAccessor(modelName, relationName, relation, resolveRelations);
      continue;
    }
    related[relationName] = {
      get: () => assertDirectRelation(modelName, relationName, relation, 'must be a supported relation.'),
      use: () => assertDirectRelation(modelName, relationName, relation, 'must be a supported relation.'),
      count: () => assertDirectRelation(modelName, relationName, relation, 'must be a supported relation.')
    };
  }
  return related;
};
exports.buildRelatedAccessors = buildRelatedAccessors;
const buildRowRelatedRecord = (row, resolveRelations, resolveRelatedAccessors) => {
  const relatedRecord = {};
  const relatedAccessors = resolveRelatedAccessors();
  const relations = resolveRelations();
  for (const relationName of Object.keys(relatedAccessors)) {
    Object.defineProperty(relatedRecord, relationName, {
      enumerable: true,
      configurable: true,
      get() {
        const relation = relations[relationName];
        if (isBelongsToRelation(relation)) {
          return getParentRow(relation, row);
        }
        if (isHasOneRelation(relation)) {
          return resolveRelatedAccessors()[relationName]?.get(row.id);
        }
        return resolveRelatedAccessors()[relationName]?.get(row.id) ?? [];
      }
    });
  }
  return relatedRecord;
};
const attachRowRelated = (modelName, row, resolveRelations, resolveRelatedAccessors) => {
  if (Object.prototype.hasOwnProperty.call(row, 'related')) {
    return row;
  }
  if (!Object.isExtensible(row)) {
    throw new Error(`[${modelName}] cannot attach row-level relations to a non-extensible stored row.`);
  }
  Object.defineProperty(row, 'related', {
    enumerable: false,
    configurable: true,
    get() {
      let relatedRecord = rowRelatedRecords.get(row);
      if (!relatedRecord) {
        relatedRecord = buildRowRelatedRecord(row, resolveRelations, resolveRelatedAccessors);
        rowRelatedRecords.set(row, relatedRecord);
      }
      return relatedRecord;
    }
  });
  return row;
};
exports.attachRowRelated = attachRowRelated;
const touchBelongsToParents = (relations, row) => {
  if (!row || touchDepth > 0) return;
  const touchRelations = Object.values(relations).filter(relation => isBelongsToRelation(relation) && relation.touch);
  if (touchRelations.length === 0) return;
  touchDepth += 1;
  try {
    const updatedAt = new Date().toISOString();
    for (const relation of touchRelations) {
      const parentId = readParentId(row, relation.foreignKey);
      if (!parentId || !relation.model.get(parentId)) continue;
      relation.model.patch(parentId, {
        updatedAt
      });
    }
  } finally {
    touchDepth = Math.max(0, touchDepth - 1);
  }
};
exports.touchBelongsToParents = touchBelongsToParents;
const propagateBelongsToParents = (relations, row) => {
  if (!row) return;
  const propagateRelations = Object.values(relations).filter(relation => isBelongsToRelation(relation) && typeof relation.propagate === 'function');
  if (propagateRelations.length === 0) return;
  for (const relation of propagateRelations) {
    const parentId = readParentId(row, relation.foreignKey);
    if (!parentId) continue;
    const parent = relation.model.get(parentId);
    if (!parent) continue;
    const projected = relation.propagate?.(row, parent);
    if (projected === null || projected === undefined) continue;
    const patch = (0, _pickDefined.pickDefined)(projected, Object.keys(projected));
    relation.model.patch(parentId, patch);
  }
};
exports.propagateBelongsToParents = propagateBelongsToParents;
//# sourceMappingURL=relations.js.map