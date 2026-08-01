"use strict";

import { defineModelRuntime } from "./defineModelRuntime.js";
import { registerRelationTarget } from "../core/relations.js";
import { registerBootValidation } from "./bootValidations.js";
import { getInternalModelHandle, registerInternalModelHandle } from "../core/internalHandles.js";
import { createAssociationRelation, createByIdsRelation, createNamedRelation, createWhereRelation } from "./facadeRelations.js";
import { createAction, createOperation } from "./facadeActions.js";
import { compileRemoteRelations } from "./facadeRemoteQueries.js";
export const defineModelFacade = (key, config) => {
  let associationCache;
  const associations = () => {
    associationCache ??= config.associations?.() ?? {};
    return associationCache;
  };
  const relationSpecs = Object.fromEntries(Object.entries(config.relations ?? {}).map(([name, relation]) => [name, {
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
    gc: config.gc,
    maintenance: config.maintenance,
    write: config.write
  }, {
    sideloads: config.sideloads
  });
  const compiledRelations = compileRemoteRelations(runtime, config.relations);
  const relationMethods = Object.create(null);
  for (const name of Object.keys(config.relations ?? {})) {
    const method = params => createNamedRelation(runtime, name, params, compiledRelations[name], config.relations?.[name]?.remote?.type);
    Reflect.set(method, 'invalidate', () => compiledRelations[name]?.invalidate());
    Reflect.set(relationMethods, name, method);
  }
  const actions = Object.create(null);
  const events = runtime.ingest(Object.fromEntries(Object.entries(config.events ?? {}).map(([name, definition]) => {
    const live = definition;
    return [name, {
      document: live.document,
      debounce: live.debounce,
      handler: live.handler
    }];
  })));
  const base = {
    key,
    find: runtime.find,
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
  const actionOwner = modelBase;
  const actionDefinitions = (typeof config.actions === 'function' ? config.actions(actionOwner) : config.actions) ?? {};
  for (const [name, definition] of Object.entries(actionDefinitions)) {
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