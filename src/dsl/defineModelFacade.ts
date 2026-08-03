import type {
  ModelBuildInput,
  ModelAssociationMethods,
  ModelFacadeCore,
  ModelFacadeBase,
  ModelFacade,
  ModelFacadeConfig,
  ModelActionMethods,
  ModelRelationMethods,
  Relation,
  ModelStoredValue,
  AnyFields,
  DbReadOptions,
  DbShape,
  FacadeRuntimeModel,
  DbWhere,
  GraphqlActionDefinition,
  GraphqlLiveDefinition,
  ModelConfigurationOwner,
  ModelEventHandle,
  RelationDecl,
  RelationSpec
} from '../types';
import { defineModelRuntime } from './defineModelRuntime';
import { registerRelationTarget } from '../core/relations';
import { registerBootValidation } from './bootValidations';
import { getInternalModelHandle, registerInternalModelHandle } from '../core/internalHandles';
import { createAssociationRelation, createByIdsRelation, createNamedRelation, createWhereRelation } from './facadeRelations';
import { createAction, createOperation } from './facadeActions';
import { compileRemoteRelations } from './facadeRemoteQueries';
import { waitForCommittedRow } from '../core/waitForCommittedRow';
import { registerModelEvent } from '../core/modelEventRegistry';
import { createGraphqlDsl } from './graphql';
import { createModelNormalization } from './modelNormalization';

export const defineModelFacade = <
  const TKey extends string,
  TShape extends DbShape<any, AnyFields>,
  const TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>> = Record<never, never>,
  const TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>> = Record<never, never>,
  const TEvents extends Record<string, GraphqlLiveDefinition<any, any, any, any, any>> = Record<never, never>,
  const TAssociations extends Record<string, RelationDecl<unknown>> = Record<never, never>,
  TStatics extends Record<string, unknown> = Record<never, never>
>(
  key: TKey,
  config: ModelFacadeConfig<TShape, TRelations, TActions, TEvents, TAssociations, TStatics, TKey>
): ModelFacade<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations, TStatics, TKey> => {
  let associationCache: TAssociations | undefined;
  const associations = (): TAssociations => {
    associationCache ??= config.associations?.() ?? ({} as TAssociations);
    return associationCache;
  };
  const ownerNormalization = createModelNormalization({
    id: key,
    name: key,
    fields: config.schema.fields,
    rowId: config.rowId,
    guard: config.guard,
    write: config.write
  } as never);
  const ownerState: {
    runtime: FacadeRuntimeModel<ModelStoredValue<TShape>, ModelBuildInput<TShape>> | undefined;
    readsEnabled: boolean;
  } = { runtime: undefined, readsEnabled: false };
  const readOwnerRuntime = (): FacadeRuntimeModel<ModelStoredValue<TShape>, ModelBuildInput<TShape>> => {
    if (!ownerState.runtime || !ownerState.readsEnabled) throw new Error(`${key}: owner reads are only available inside deferred declaration callbacks`);
    return ownerState.runtime;
  };
  const owner = {
    key,
    find: (id: string | null | undefined) => readOwnerRuntime().find(id),
    where: (where: DbWhere<ModelStoredValue<TShape>>, options?: DbReadOptions<ModelStoredValue<TShape>>) => {
      const relation = createWhereRelation(readOwnerRuntime(), where, options);
      return { read: relation.read, count: relation.count, issueSequence: relation.issueSequence };
    },
    byIds: (ids: readonly string[] | null | undefined) => {
      const relation = createByIdsRelation(readOwnerRuntime(), ids);
      return { read: relation.read, count: relation.count, issueSequence: relation.issueSequence };
    },
    build: input => ownerNormalization.normalize(input, true) as ModelStoredValue<TShape>,
    gql: createGraphqlDsl<TKey, ModelBuildInput<TShape>, ModelStoredValue<TShape>>()
  } as ModelConfigurationOwner<TKey, ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations>;
  const relationDefinitions = config.relations?.(owner) ?? ({} as TRelations);
  const relationSpecs = Object.fromEntries(
    Object.entries(relationDefinitions).map(([name, relation]) => [
      name,
      {
        by: relation.by,
        member: relation.member,
        sort: relation.sort,
        retention: relation.retention
      }
    ])
  );
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
  } as never, { sideloads: config.sideloads }) as FacadeRuntimeModel<ModelStoredValue<TShape>, ModelBuildInput<TShape>>;
  ownerState.runtime = runtime;

  const eventOwner = {
    modelId: key,
    planRows: (rows: readonly ModelBuildInput<TShape>[]) => getInternalModelHandle(runtime).planRows([...rows], { origin: 'event' })
  };
  const compiledRelations = compileRemoteRelations<TShape>(runtime, relationDefinitions);
  const relationMethods: ModelRelationMethods<ModelStoredValue<TShape>, TRelations, ModelBuildInput<TShape>> = Object.create(null);
  for (const name of Object.keys(relationDefinitions)) {
    const method = (params: Record<string, unknown> | null) =>
      createNamedRelation(runtime, name, params, compiledRelations[name], relationDefinitions[name]?.remote?.type);
    Reflect.set(method, 'invalidate', () => compiledRelations[name]?.invalidate());
    Reflect.set(relationMethods, name, method);
    Reflect.set(owner, name, (params: Record<string, unknown> | null) => {
      const relation = createNamedRelation(readOwnerRuntime(), name, params, compiledRelations[name], relationDefinitions[name]?.remote?.type);
      return { read: relation.read, count: relation.count, issueSequence: relation.issueSequence };
    });
  }
  const actionDefinitions = config.actions?.(owner) ?? ({} as TActions);
  const eventDefinitions = config.events?.(owner) ?? ({} as TEvents);
  ownerState.readsEnabled = true;
  const actions: ModelActionMethods<TActions> = Object.create(null);
  const events = Object.create(null) as ModelEventHandle<TEvents>;
  for (const [name, definition] of Object.entries(eventDefinitions)) {
    const live = definition as GraphqlLiveDefinition<any, any, ModelBuildInput<TShape>, ModelStoredValue<TShape>, TKey>;
    Reflect.set(
      events,
      name,
      registerModelEvent({
        modelKey: key,
        eventName: name,
        document: live.document,
        variables: live.variables,
        debounce: live.debounce,
        owner: eventOwner,
        root: live.root,
        write: live.write
      })
    );
  }
  const base: ModelFacadeCore<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TActions, TEvents, TKey> = {
    key,
    find: runtime.find,
    wait: (id, options) => waitForCommittedRow({ key, find: runtime.find }, id, options),
    useFind: runtime.use.find,
    where: (where: DbWhere<ModelStoredValue<TShape>>, options?: DbReadOptions<ModelStoredValue<TShape>>) => createWhereRelation(runtime, where, options),
    byIds: (ids: readonly string[] | null | undefined) => createByIdsRelation(runtime, ids),
    insert: (row: ModelBuildInput<TShape>) => runtime.insert(row as ModelStoredValue<TShape>),
    insertMany: (rows: ModelBuildInput<TShape>[]) => runtime.insertMany(rows as ModelStoredValue<TShape>[]),
    update: runtime.update,
    updateAll: runtime.updateAll,
    destroy: runtime.destroy,
    destroyMany: runtime.destroyMany,
    destroyAll: runtime.destroyAll,
    build: (input: ModelBuildInput<TShape>) => runtime.build(input),
    operation: (id: string | null | undefined) => createOperation(runtime, id),
    actions,
    events
  };
  const modelBase: ModelFacadeBase<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations, TKey> = Object.assign(
    base,
    relationMethods,
    Object.create(null) as ModelAssociationMethods<TAssociations>
  );
  for (const [name, definition] of Object.entries(actionDefinitions)) {
    if ('optimistic' in definition && definition.optimistic?.root && 'insert' in definition.optimistic.root && config.maintenance?.dropTempRowsAfterMs === undefined) {
      throw new Error(`${key}.${name}: optimistic insert requires maintenance.dropTempRowsAfterMs`);
    }
    Reflect.set(actions, name, createAction(runtime, `${key}:${name}`, definition));
  }
  const associationMethods = new Map<string, (id: string | null | undefined) => Relation<any, any>>();
  let associationsValidated = false;
  const validateAssociations = (): void => {
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
      const method = (id: string | null | undefined) =>
        createAssociationRelation<ModelStoredValue<TShape>, ModelBuildInput<TShape>, typeof definition>(runtime, property, id);
      associationMethods.set(property, method);
      return method;
    }
  });
  registerRelationTarget(key, model);
  registerInternalModelHandle(model, getInternalModelHandle(runtime));
  const statics = config.statics?.(model) ?? ({} as TStatics);
  for (const name of Object.keys(statics)) {
    if (name in model) throw new Error(`${key}: static ${name} collides with the model surface`);
  }
  return Object.assign(model, statics);
};
