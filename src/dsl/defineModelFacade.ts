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

export const defineModelFacade = <
  const TKey extends string,
  TShape extends DbShape<any, AnyFields>,
  const TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>>,
  const TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>,
  const TEvents extends Record<string, { type: 'live' }>,
  const TAssociations extends Record<string, RelationDecl<unknown>>,
  TStatics extends Record<string, unknown>
>(
  key: TKey,
  config: ModelFacadeConfig<TShape, TRelations, TActions, TEvents, TAssociations, TStatics>
): ModelFacade<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations, TStatics> => {
  let associationCache: TAssociations | undefined;
  const associations = (): TAssociations => {
    associationCache ??= config.associations?.() ?? ({} as TAssociations);
    return associationCache;
  };
  const relationSpecs = Object.fromEntries(
    Object.entries(config.relations ?? {}).map(([name, relation]) => [
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
    gc: config.gc,
    maintenance: config.maintenance,
    write: config.write
  } as never, { sideloads: config.sideloads }) as FacadeRuntimeModel<ModelStoredValue<TShape>, ModelBuildInput<TShape>>;

  const compiledRelations = compileRemoteRelations<TShape>(runtime, config.relations);
  const relationMethods: ModelRelationMethods<ModelStoredValue<TShape>, TRelations, ModelBuildInput<TShape>> = Object.create(null);
  for (const name of Object.keys(config.relations ?? {})) {
    const method = (params: Record<string, unknown> | null) =>
      createNamedRelation(runtime, name, params, compiledRelations[name], config.relations?.[name]?.remote?.type);
    Reflect.set(method, 'invalidate', () => compiledRelations[name]?.invalidate());
    Reflect.set(relationMethods, name, method);
  }
  const actions: ModelActionMethods<TActions> = Object.create(null);
  const events = runtime.ingest(
    Object.fromEntries(
      Object.entries(config.events ?? {}).map(([name, definition]) => {
        const live = definition as GraphqlLiveDefinition<any, any>;
        return [
          name,
          {
            document: live.document,
            debounce: live.debounce,
            handler: live.handler
          }
        ];
      })
    )
  );
  const base: ModelFacadeCore<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TActions, TEvents> = {
    key,
    find: runtime.find,
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
  const modelBase: ModelFacadeBase<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TEvents, TAssociations> = Object.assign(
    base,
    relationMethods,
    Object.create(null) as ModelAssociationMethods<TAssociations>
  );
  const actionOwner = modelBase as ModelFacadeCore<
    ModelStoredValue<TShape>,
    ModelBuildInput<TShape>,
    Record<string, never>,
    Record<string, never>
  > &
    ModelRelationMethods<ModelStoredValue<TShape>, TRelations, ModelBuildInput<TShape>>;
  const actionDefinitions = (typeof config.actions === 'function' ? config.actions(actionOwner) : config.actions) ?? ({} as TActions);
  for (const [name, definition] of Object.entries(actionDefinitions)) {
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
