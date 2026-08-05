"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.defineModelFacade = void 0;
var _defineModelRuntime = require("./defineModelRuntime.js");
var _relations = require("../core/relations.js");
var _bootValidations = require("./bootValidations.js");
var _internalHandles = require("../core/internalHandles.js");
var _facadeRelations = require("./facadeRelations.js");
var _facadeActions = require("./facadeActions.js");
var _facadeRemoteQueries = require("./facadeRemoteQueries.js");
var _waitForCommittedRow = require("../core/waitForCommittedRow.js");
var _modelEventRegistry = require("../core/modelEventRegistry.js");
var _graphql = require("./graphql.js");
var _modelNormalization = require("./modelNormalization.js");
const defineModelFacade = (key, config) => {
  let associationCache;
  const associations = () => {
    associationCache ??= config.associations?.() ?? {};
    return associationCache;
  };
  const ownerNormalization = (0, _modelNormalization.createModelNormalization)({
    id: key,
    name: key,
    fields: config.schema.fields,
    rowId: config.rowId,
    guard: config.guard,
    write: config.write
  });
  const ownerState = {
    runtime: undefined,
    readsEnabled: false
  };
  const readOwnerRuntime = () => {
    if (!ownerState.runtime || !ownerState.readsEnabled) throw new Error(`${key}: owner reads are only available inside deferred declaration callbacks`);
    return ownerState.runtime;
  };
  const owner = {
    key,
    find: id => readOwnerRuntime().find(id),
    where: (where, options) => {
      const relation = (0, _facadeRelations.createWhereRelation)(readOwnerRuntime(), where, options);
      return {
        read: relation.read,
        count: relation.count,
        issueSequence: relation.issueSequence
      };
    },
    byIds: ids => {
      const relation = (0, _facadeRelations.createByIdsRelation)(readOwnerRuntime(), ids);
      return {
        read: relation.read,
        count: relation.count,
        issueSequence: relation.issueSequence
      };
    },
    build: input => ownerNormalization.normalize(input, true),
    gql: (0, _graphql.createGraphqlDsl)()
  };
  const relationDefinitions = config.relations?.(owner) ?? {};
  const relationSpecs = Object.fromEntries(Object.entries(relationDefinitions).map(([name, relation]) => [name, {
    by: relation.by,
    member: relation.member,
    sort: relation.sort,
    retention: relation.retention
  }]));
  const runtime = (0, _defineModelRuntime.defineModelRuntime)({
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
  ownerState.runtime = runtime;
  const eventOwner = {
    modelId: key,
    planRows: rows => (0, _internalHandles.getInternalModelHandle)(runtime).planRows([...rows], {
      origin: 'event'
    })
  };
  const compiledRelations = (0, _facadeRemoteQueries.compileRemoteRelations)(runtime, relationDefinitions);
  const relationMethods = Object.create(null);
  for (const name of Object.keys(relationDefinitions)) {
    const method = params => (0, _facadeRelations.createNamedRelation)(runtime, name, params, compiledRelations[name], relationDefinitions[name]?.remote?.type);
    Reflect.set(method, 'invalidate', () => compiledRelations[name]?.invalidate());
    Reflect.set(relationMethods, name, method);
    Reflect.set(owner, name, params => {
      const relation = (0, _facadeRelations.createNamedRelation)(readOwnerRuntime(), name, params, compiledRelations[name], relationDefinitions[name]?.remote?.type);
      return {
        read: relation.read,
        count: relation.count,
        issueSequence: relation.issueSequence
      };
    });
  }
  const actionDefinitions = config.actions?.(owner) ?? {};
  const eventDefinitions = config.events?.(owner) ?? {};
  ownerState.readsEnabled = true;
  const actions = Object.create(null);
  const events = Object.create(null);
  for (const [name, definition] of Object.entries(eventDefinitions)) {
    const live = definition;
    Reflect.set(events, name, (0, _modelEventRegistry.registerModelEvent)({
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
    wait: (id, options) => (0, _waitForCommittedRow.waitForCommittedRow)({
      key,
      find: runtime.find
    }, id, options),
    useFind: runtime.use.find,
    where: (where, options) => (0, _facadeRelations.createWhereRelation)(runtime, where, options),
    byIds: ids => (0, _facadeRelations.createByIdsRelation)(runtime, ids),
    insert: row => runtime.insert(row),
    insertMany: rows => runtime.insertMany(rows),
    update: runtime.update,
    updateAll: runtime.updateAll,
    destroy: runtime.destroy,
    destroyMany: runtime.destroyMany,
    destroyAll: runtime.destroyAll,
    build: input => runtime.build(input),
    operation: id => (0, _facadeActions.createOperation)(runtime, id),
    actions,
    events
  };
  for (const name of Object.keys(relationDefinitions)) {
    if (name in base) throw new Error(`${key}: relation ${name} collides with the model surface`);
  }
  const modelBase = Object.assign(base, relationMethods, Object.create(null));
  for (const [name, definition] of Object.entries(actionDefinitions)) {
    if ('optimistic' in definition && definition.optimistic?.root && 'insert' in definition.optimistic.root && config.maintenance?.dropTempRowsAfterMs === undefined) {
      throw new Error(`${key}.${name}: optimistic insert requires maintenance.dropTempRowsAfterMs`);
    }
    Reflect.set(actions, name, (0, _facadeActions.createAction)(runtime, `${key}:${name}`, definition));
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
  (0, _bootValidations.registerBootValidation)(`model-associations:${key}`, validateAssociations);
  const model = new Proxy(modelBase, {
    get: (target, property, receiver) => {
      validateAssociations();
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (typeof property !== 'string') return undefined;
      const definition = associations()[property];
      if (!definition) return undefined;
      const existing = associationMethods.get(property);
      if (existing) return existing;
      const method = id => (0, _facadeRelations.createAssociationRelation)(runtime, property, id);
      associationMethods.set(property, method);
      return method;
    }
  });
  (0, _relations.registerRelationTarget)(key, model);
  (0, _internalHandles.registerInternalModelHandle)(model, (0, _internalHandles.getInternalModelHandle)(runtime));
  const statics = config.statics?.(model) ?? {};
  for (const name of Object.keys(statics)) {
    if (name in model) throw new Error(`${key}: static ${name} collides with the model surface`);
  }
  return Object.assign(model, statics);
};
exports.defineModelFacade = defineModelFacade;
//# sourceMappingURL=defineModelFacade.js.map