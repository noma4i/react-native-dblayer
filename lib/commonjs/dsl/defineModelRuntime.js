"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModelRuntime = void 0;
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
var _modelLandingGraph = require("./modelLandingGraph.js");
var _applyTargetRegistry = require("../core/apply/applyTargetRegistry.js");
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
const defineModelRuntime = (config, landing) => {
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
  const scopeSpecs = config.scopes ?? {};
  const membershipScopes = Object.entries(scopeSpecs).flatMap(([name, spec]) => spec.by ? [[name, {
    ...spec,
    by: spec.by
  }]] : []);
  const scopeByFieldMap = new Map(membershipScopes.map(([name, spec]) => [name, spec.by]));
  const {
    keyForScope,
    normalizeScopeValue,
    isScopeValueComplete,
    scopeValueFromRow
  } = (0, _modelScopeKeys.createModelScopeKeys)(config, scopeByFieldMap);
  const {
    matches: matchesCriteria,
    normalize: normalizeCriteria
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
    read: id => planes().entityState.read(id),
    membershipForUpsert,
    detachForDestroy
  });
  const captureMembership = id => planes().scopeIndex.keysOf(id).map(scopeKey => ({
    id,
    scopeKey,
    orderKey: planes().scopeIndex.read(scopeKey).entries.find(candidate => candidate.id === id).orderKey
  }));
  const {
    prepareRow,
    preparePatch,
    putRows,
    planRows: planOwnRows,
    planReplace: planOwnReplace,
    planRestore
  } = (0, _modelWrites.createModelWrites)({
    modelId: config.id,
    modelName: config.name,
    entityState: () => planes().entityState,
    normalize,
    isPlanRow,
    bumpRevision: context.bumpRevision,
    captureMembership
  });
  if (landing) {
    (0, _modelLandingGraph.registerModelLandingHost)(config.id, {
      normalize,
      planOwnRows,
      sideloads: landing.sideloads
    });
  }
  const planRows = landing ? (rows, planOptions) => (0, _modelLandingGraph.planModelLanding)(config.id, rows, planOptions) : planOwnRows;
  const planReplace = landing ? (oldId, next) => (0, _modelLandingGraph.planModelLandingWithRoot)(config.id, [next], rows => planOwnReplace(oldId, rows[0])) : planOwnReplace;
  const {
    rowDep,
    modelDep,
    useScopeAccess,
    scopeSortedRows,
    whereRead
  } = (0, _modelReadAccess.createModelReadAccess)({
    modelId: config.id,
    context,
    scopes: config.scopes,
    defaultOrder: config.defaultOrder,
    keyForScope,
    matchesCriteria,
    normalizeCriteria
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
  (0, _applyTargetRegistry.registerApplyTarget)(config.id, applyTarget);
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
    normalizeScopeValue,
    isScopeValueComplete,
    scopeValueFromRow,
    isPlanRow,
    normalize,
    applyTarget,
    useScopeAccess,
    scopeSortedRows,
    planRows,
    applySnapshot,
    applyEvent
  });
  let consumerResetSequence = 0;
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
      normalizeCriteria,
      rowDep,
      modelDep,
      whereRead
    }),
    scopes: scopeHandles,
    registerReset: fn => {
      (0, _reset.registerKeyedReset)(`model-consumer:${config.id}:${consumerResetSequence += 1}`, fn);
    }
  };
  context.setModel(model);
  (0, _modelRegistrations.registerModelRuntime)({
    modelId: config.id,
    modelName: config.name,
    context,
    maintenance: config.maintenance,
    normalize,
    applySnapshot,
    planRows,
    planReplace,
    captureMembership,
    planRestore
  });
  const queryScopeSpecs = config.queryScopes ?? {};
  for (const [scopeName, spec] of Object.entries(queryScopeSpecs)) {
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
exports.defineModelRuntime = defineModelRuntime;
//# sourceMappingURL=defineModelRuntime.js.map