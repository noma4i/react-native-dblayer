"use strict";

import { defineModelRuntime } from "./defineModelRuntime.js";
import { registerRelationTarget } from "../core/relations.js";
import { registerBootValidation } from "./bootValidations.js";
import { getInternalModelHandle, registerInternalModelHandle } from "../core/internalHandles.js";
import { createAssociationRelation, createByIdsRelation, createNamedRelation, createWhereRelation } from "./facadeRelations.js";
import { createAction, createOperation } from "./facadeActions.js";
import { compileRemoteRelations } from "./facadeRemoteQueries.js";
import { waitForCommittedRow } from "../core/waitForCommittedRow.js";
import { registerModelEvent } from "../core/modelEventRegistry.js";
import { createGraphqlDsl } from "./graphql.js";
import { createModelNormalization } from "./modelNormalization.js";
export const defineModelFacade = (key, config) => {
  let associationCache;
  const associations = () => {
    associationCache ??= config.associations?.() ?? {};
    return associationCache;
  };
  const ownerNormalization = createModelNormalization({
    id: key,
    name: key,
    fields: config.schema.fields,
    rowId: config.rowId,
    guard: config.guard,
    write: config.write
  });
  const owner = {
    key,
    build: input => ownerNormalization.normalize(input, true),
    gql: createGraphqlDsl()
  };
  const relationDefinitions = config.relations?.(owner) ?? {};
  const actionDefinitions = config.actions?.(owner) ?? {};
  const eventDefinitions = config.events?.(owner) ?? {};
  const relationSpecs = Object.fromEntries(Object.entries(relationDefinitions).map(([name, relation]) => [name, {
    by: relation.by,
    member: relation.member,
    sort: relation.sort,
    retention: relation.retention
  }]));
  const runtime = defineModelRuntime({
    id: key,
    name: key,
    fields: config.schema.fields,
    defaultOrder: config.defaultOrder,
    rowId: config.rowId,
    guard: config.guard,
    relations: associations,
    scopes: relationSpecs,
    maintenance: config.maintenance,
    write: config.write
  }, {
    sideloads: config.sideloads
  });
  const eventOwner = {
    modelId: key,
    planRows: rows => getInternalModelHandle(runtime).planRows([...rows], {
      origin: 'event'
    })
  };
  const compiledRelations = compileRemoteRelations(runtime, relationDefinitions);
  const relationMethods = Object.create(null);
  for (const name of Object.keys(relationDefinitions)) {
    const method = params => createNamedRelation(runtime, name, params, compiledRelations[name], relationDefinitions[name]?.remote?.type);
    Reflect.set(method, 'invalidate', () => compiledRelations[name]?.invalidate());
    Reflect.set(relationMethods, name, method);
  }
  const actions = Object.create(null);
  const events = Object.create(null);
  for (const [name, definition] of Object.entries(eventDefinitions)) {
    const live = definition;
    Reflect.set(events, name, registerModelEvent({
      modelKey: key,
      eventName: name,
      document: live.document,
      variables: live.variables,
      debounce: live.debounce,
      owner: eventOwner,
      root: live.root,
      write: live.write
    }));
  }
  const base = {
    key,
    find: runtime.find,
    wait: (id, options) => waitForCommittedRow({
      key,
      find: runtime.find
    }, id, options),
    useFind: runtime.use.find,
    where: (where, options) => createWhereRelation(runtime, where, options),
    byIds: ids => createByIdsRelation(runtime, ids),
    insert: row => runtime.insert(row),
    insertMany: rows => runtime.insertMany(rows),
    update: runtime.update,
    updateAll: runtime.updateAll,
    destroy: runtime.destroy,
    destroyMany: runtime.destroyMany,
    destroyAll: runtime.destroyAll,
    build: input => runtime.build(input),
    operation: id => createOperation(runtime, id),
    actions,
    events
  };
  const modelBase = Object.assign(base, relationMethods, Object.create(null));
  for (const [name, definition] of Object.entries(actionDefinitions)) {
    if ('optimistic' in definition && definition.optimistic?.root && 'insert' in definition.optimistic.root && config.maintenance?.dropTempRowsAfterMs === undefined) {
      throw new Error(`${key}.${name}: optimistic insert requires maintenance.dropTempRowsAfterMs`);
    }
    Reflect.set(actions, name, createAction(runtime, `${key}:${name}`, definition));
  }
  const associationMethods = new Map();
  let associationsValidated = false;
  const validateAssociations = () => {
    if (associationsValidated) return;
    for (const name of Object.keys(associations())) {
      if (Reflect.has(modelBase, name) || name in actionDefinitions) {
        throw new Error(`${key}: association ${name} collides with the model surface`);
      }
    }
    associationsValidated = true;
  };
  registerBootValidation(`model-associations:${key}`, validateAssociations);
  const model = new Proxy(modelBase, {
    get: (target, property, receiver) => {
      validateAssociations();
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (typeof property !== 'string') return undefined;
      const definition = associations()[property];
      if (!definition) return undefined;
      const existing = associationMethods.get(property);
      if (existing) return existing;
      const method = id => createAssociationRelation(runtime, property, id);
      associationMethods.set(property, method);
      return method;
    }
  });
  registerRelationTarget(key, model);
  registerInternalModelHandle(model, getInternalModelHandle(runtime));
  const statics = config.statics?.(model) ?? {};
  for (const name of Object.keys(statics)) {
    if (name in model) throw new Error(`${key}: static ${name} collides with the model surface`);
  }
  return Object.assign(model, statics);
};
//# sourceMappingURL=defineModelFacade.js.map