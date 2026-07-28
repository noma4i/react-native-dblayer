"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModel = void 0;
var _relations = require("../core/relations.js");
var _reset = require("../core/reset.js");
var _modelNormalization = require("./modelNormalization.js");
var _modelScopeKeys = require("./modelScopeKeys.js");
var _modelCriteria = require("./modelCriteria.js");
var _modelContext = require("./modelContext.js");
var _modelMembership = require("./modelMembership.js");
var _modelWrites = require("./modelWrites.js");
var _modelApplyTarget = require("./modelApplyTarget.js");
var _modelReadAccess = require("./modelReadAccess.js");
var _modelReactiveReads = require("./modelReactiveReads.js");
var _modelScopeHandle = require("./modelScopeHandle.js");
var _modelDefinitions = require("./modelDefinitions.js");
var _modelDirectAccess = require("./modelDirectAccess.js");
var _modelRegistrations = require("./modelRegistrations.js");
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
const defineModel = config => {
  const {
    applyWriteGate,
    isPlanRow,
    normalize
  } = (0, _modelNormalization.createModelNormalization)(config);
  const context = (0, _modelContext.createModelContext)({
    modelId: config.id,
    scopeNames: Object.keys(config.scopes ?? {}),
    relations: () => config.relations?.() ?? {},
    applyWriteGate
  });
  const {
    planes,
    resolvedRelations
  } = context;
  const membershipScopes = Object.entries(config.scopes ?? {}).flatMap(([name, spec]) => spec.by ? [[name, {
    ...spec,
    by: spec.by
  }]] : []);
  const scopeByFieldMap = new Map(membershipScopes.map(([name, spec]) => [name, spec.by]));
  const {
    keyForScope,
    scopeValueFromRow
  } = (0, _modelScopeKeys.createModelScopeKeys)(config, scopeByFieldMap);
  const {
    matches: matchesCriteria
  } = (0, _modelCriteria.createModelCriteria)(config.fields);
  const {
    membershipForUpsert,
    detachForDestroy
  } = (0, _modelMembership.createModelMembership)({
    membershipScopes,
    keyForScope,
    scopeValueFromRow,
    isScopeMember: (scopeKey, id) => planes().scopeIndex.has(scopeKey, id),
    scopeKeysOf: id => planes().scopeIndex.keysOf(id)
  });
  (0, _relations.registerRelationHost)(config.id, {
    relations: resolvedRelations,
    has: id => planes().entityState.read(id) !== undefined,
    read: id => planes().entityState.read(id),
    normalize: input => {
      try {
        return normalize(input);
      } catch {
        return null;
      }
    },
    membershipForUpsert,
    detachForDestroy
  });
  const captureMembership = id => planes().scopeIndex.keysOf(id).flatMap(scopeKey => {
    const entry = planes().scopeIndex.read(scopeKey).entries.find(candidate => candidate.id === id);
    return entry ? [{
      id,
      scopeKey,
      order: entry.order,
      edge: entry.edge
    }] : [];
  });
  const {
    prepareRow,
    preparePatch,
    putRows,
    planRows,
    planReplace,
    planRestore,
    splitCorrelatedRows
  } = (0, _modelWrites.createModelWrites)({
    modelId: config.id,
    modelName: config.name,
    entityState: () => planes().entityState,
    normalize,
    isPlanRow,
    bumpRevision: context.bumpRevision,
    captureMembership
  });
  const {
    rowDep,
    modelDep,
    scopeDep,
    useScopeAccess,
    scopeSortedRows,
    whereRead
  } = (0, _modelReadAccess.createModelReadAccess)({
    modelId: config.id,
    context,
    scopes: config.scopes,
    defaultOrder: config.defaultOrder,
    keyForScope,
    matchesCriteria
  });
  const {
    applyTarget,
    applySnapshot,
    applyEvent
  } = (0, _modelApplyTarget.createModelApplyTarget)({
    modelId: config.id,
    scopes: config.scopes,
    context,
    scopeSortedRows,
    prepareRow,
    preparePatch,
    putRows
  });
  (0, _modelRegistrations.registerModelSchemaAndGc)({
    modelId: config.id,
    modelName: config.name,
    fields: config.fields,
    scopes: config.scopes,
    gc: config.gc,
    dropIdleScopesAfterMs: config.maintenance?.dropIdleScopesAfterMs,
    context
  });
  const makeScopeHandle = (0, _modelScopeHandle.createModelScopeHandle)({
    modelId: config.id,
    modelName: config.name,
    context,
    scopes: config.scopes,
    keyForScope,
    scopeValueFromRow,
    isPlanRow,
    normalize,
    applyTarget,
    scopeDep,
    useScopeAccess,
    scopeSortedRows,
    splitCorrelatedRows,
    applySnapshot,
    applyEvent
  });
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)]));
  const model = {
    modelId: config.id,
    ...(0, _modelDefinitions.createModelDefinitions)({
      modelId: config.id,
      context
    }),
    ...(0, _modelDirectAccess.createModelDirectAccess)({
      modelId: config.id,
      context,
      defaultOrder: config.defaultOrder,
      matchesCriteria,
      applyEvent,
      planRows,
      planReplace,
      normalize
    }),
    use: (0, _modelReactiveReads.createModelReactiveReads)({
      modelId: config.id,
      modelName: config.name,
      context,
      defaultOrder: config.defaultOrder,
      matchesCriteria,
      rowDep,
      modelDep,
      whereRead
    }),
    scopes: scopeHandles,
    registerReset: fn => {
      (0, _reset.registerReset)(fn);
    }
  };
  context.setModel(model);
  (0, _modelRegistrations.registerModelRuntime)({
    modelId: config.id,
    modelName: config.name,
    context,
    maintenance: config.maintenance,
    applySnapshot,
    planRows,
    planReplace,
    captureMembership,
    planRestore
  });
  for (const [scopeName, spec] of Object.entries(config.queryScopes ?? {})) {
    if (scopeName in model.use) throw new Error(`${config.name} queryScope '${scopeName}' collides with a built-in use key`);
    model.use[scopeName] = extra => {
      const criteria = extra ? {
        and: [spec.where, extra]
      } : spec.where;
      let builder = whereRead(criteria);
      if (spec.orderBy) builder = builder.orderBy(spec.orderBy.field, spec.orderBy.direction);
      if (spec.limit !== undefined) builder = builder.limit(spec.limit);
      return builder;
    };
  }
  const statics = config.statics?.(model);
  if (statics) {
    for (const key of Object.keys(statics)) {
      if (key in model) throw new Error(`${config.name} statics collide with base model key ${key}`);
    }
  }
  return Object.assign(model, statics);
};
exports.defineModel = defineModel;
//# sourceMappingURL=defineModel.js.map