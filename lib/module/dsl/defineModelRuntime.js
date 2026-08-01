"use strict";

import { registerRelationHost } from "../core/relations.js";
import { registerKeyedReset } from "../core/reset.js";
import { createModelNormalization } from "./modelNormalization.js";
import { createModelScopeKeys } from "./modelScopeKeys.js";
import { createModelCriteria } from "./modelCriteria.js";
import { createModelContext } from "./modelContext.js";
import { createModelMembership } from "./modelMembership.js";
import { createModelWrites } from "./modelWrites.js";
import { createModelApplyTarget } from "./modelApplyTarget.js";
import { createModelReadAccess } from "./modelReadAccess.js";
import { createModelReactiveReads } from "./modelReactiveReads.js";
import { createModelScopeHandle } from "./modelScopeHandle.js";
import { createModelDefinitions } from "./modelDefinitions.js";
import { createModelDirectAccess } from "./modelDirectAccess.js";
import { registerModelRuntime, registerModelSchema } from "./modelRegistrations.js";
import { planModelLanding, planModelLandingWithRoot, registerModelLandingHost } from "./modelLandingGraph.js";
import { registerApplyTarget } from "../core/apply/applyTargetRegistry.js";
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export const defineModelRuntime = (config, landing) => {
  const {
    applyWriteGate,
    isPlanRow,
    normalize
  } = createModelNormalization(config);
  const context = createModelContext({
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
  } = createModelScopeKeys(config, scopeByFieldMap);
  const {
    matches: matchesCriteria,
    normalize: normalizeCriteria
  } = createModelCriteria(config.fields);
  const {
    membershipForUpsert,
    detachForDestroy
  } = createModelMembership({
    membershipScopes,
    keyForScope,
    scopeValueFromRow,
    isScopeMember: (scopeKey, id) => planes().scopeIndex.has(scopeKey, id),
    scopeKeysOf: id => planes().scopeIndex.keysOf(id)
  });
  registerRelationHost(config.id, {
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
  } = createModelWrites({
    modelId: config.id,
    modelName: config.name,
    entityState: () => planes().entityState,
    normalize,
    isPlanRow,
    bumpRevision: context.bumpRevision,
    captureMembership
  });
  if (landing) {
    registerModelLandingHost(config.id, {
      normalize,
      planOwnRows,
      sideloads: landing.sideloads
    });
  }
  const planRows = landing ? (rows, planOptions) => planModelLanding(config.id, rows, planOptions) : planOwnRows;
  const planReplace = landing ? (oldId, next) => planModelLandingWithRoot(config.id, [next], rows => planOwnReplace(oldId, rows[0])) : planOwnReplace;
  const {
    rowDep,
    modelDep,
    useScopeAccess,
    scopeSortedRows,
    whereRead
  } = createModelReadAccess({
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
  } = createModelApplyTarget({
    modelId: config.id,
    scopes: config.scopes,
    context,
    scopeSortedRows,
    prepareRow,
    preparePatch,
    putRows
  });
  registerApplyTarget(config.id, applyTarget);
  registerModelSchema({
    modelId: config.id,
    modelName: config.name,
    fields: config.fields,
    scopes: config.scopes,
    context
  });
  const makeScopeHandle = createModelScopeHandle({
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
    ...createModelDefinitions({
      modelId: config.id,
      context
    }),
    ...createModelDirectAccess({
      modelId: config.id,
      context,
      defaultOrder: config.defaultOrder,
      matchesCriteria,
      applyEvent,
      planRows,
      planReplace,
      normalize
    }),
    use: createModelReactiveReads({
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
      registerKeyedReset(`model-consumer:${config.id}:${consumerResetSequence += 1}`, fn);
    }
  };
  context.setModel(model);
  registerModelRuntime({
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
//# sourceMappingURL=defineModelRuntime.js.map