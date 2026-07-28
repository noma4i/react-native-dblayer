import type {
  DbWhere,
  InferBuildInput,
  InferStoredFields,
  ModelFieldSpecs,
  ModelConfig,
  ModelCore,
  QueryScopeReads,
  QueryScopeSpec,
  RequiredReadUse,
  ScopeHandle,
  ScopeSpec,
  ScopeValueOf
} from '../types';
import { registerRelationHost } from '../core/relations';
import { registerKeyedReset } from '../core/reset';
import { createModelNormalization } from './modelNormalization';
import { createModelScopeKeys } from './modelScopeKeys';
import { createModelCriteria } from './modelCriteria';
import { createModelContext } from './modelContext';
import { createModelMembership } from './modelMembership';
import { createModelWrites } from './modelWrites';
import { createModelApplyTarget } from './modelApplyTarget';
import { createModelReadAccess } from './modelReadAccess';
import { createModelReactiveReads } from './modelReactiveReads';
import { createModelScopeHandle } from './modelScopeHandle';
import { createModelDefinitions } from './modelDefinitions';
import { createModelDirectAccess } from './modelDirectAccess';
import { registerModelRuntime, registerModelSchemaAndGc } from './modelRegistrations';
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export const defineModel = <
  const TFields extends ModelFieldSpecs,
  TScopes extends Record<string, ScopeSpec<InferStoredFields<TFields>>> = {},
  TExt extends Record<string, unknown> = {},
  TQueryScopes extends Record<string, QueryScopeSpec<InferStoredFields<TFields>>> = {}
>(
  config: ModelConfig<TFields, TScopes, TExt, TQueryScopes>
): Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, 'use' | 'scopes'> & {
  use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> &
    QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
  scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>> };
} & TExt => {
  type Stored = InferStoredFields<TFields> & Record<string, unknown>;
  type Input = InferBuildInput<TFields>;
  const { applyWriteGate, isPlanRow, normalize } = createModelNormalization(config);
  const context = createModelContext<Stored>({
    modelId: config.id,
    scopeNames: Object.keys(config.scopes ?? {}),
    relations: () => config.relations?.() ?? {},
    applyWriteGate
  });
  const { planes, resolvedRelations } = context;

  const membershipScopes = Object.entries(config.scopes ?? {}).flatMap(([name, spec]) => (spec.by ? [[name, { ...spec, by: spec.by }] as const] : []));

  const scopeByFieldMap = new Map(membershipScopes.map(([name, spec]) => [name, spec.by] as const));
  const { keyForScope, scopeValueFromRow } = createModelScopeKeys(config, scopeByFieldMap);
  const { matches: matchesCriteria } = createModelCriteria<Stored>(config.fields);

  const { membershipForUpsert, detachForDestroy } = createModelMembership<Stored>({
    membershipScopes,
    keyForScope,
    scopeValueFromRow,
    isScopeMember: (scopeKey, id) => planes().scopeIndex.has(scopeKey, id),
    scopeKeysOf: id => planes().scopeIndex.keysOf(id)
  });

  registerRelationHost(config.id, {
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

  const captureMembership = (id: string): Array<{ id: string; scopeKey: string; orderKey: string; edge?: Record<string, unknown> }> =>
    planes()
      .scopeIndex.keysOf(id)
      .flatMap(scopeKey => {
        const entry = planes()
          .scopeIndex.read(scopeKey)
          .entries.find(candidate => candidate.id === id);
        return entry ? [{ id, scopeKey, orderKey: entry.orderKey, edge: entry.edge }] : [];
      });
  const { prepareRow, preparePatch, putRows, planRows, planReplace, planRestore, splitCorrelatedRows } = createModelWrites<Stored>({
    modelId: config.id,
    modelName: config.name,
    entityState: () => planes().entityState,
    normalize,
    isPlanRow,
    bumpRevision: context.bumpRevision,
    captureMembership
  });

  const { rowDep, modelDep, scopeDep, useScopeAccess, scopeSortedRows, whereRead } = createModelReadAccess<Stored>({
    modelId: config.id,
    context,
    scopes: config.scopes as Record<string, ScopeSpec<Stored>> | undefined,
    defaultOrder: config.defaultOrder,
    keyForScope,
    matchesCriteria
  });
  const { applyTarget, applySnapshot, applyEvent } = createModelApplyTarget<Stored>({
    modelId: config.id,
    scopes: config.scopes as Record<string, ScopeSpec<Stored>> | undefined,
    context,
    scopeSortedRows,
    prepareRow,
    preparePatch,
    putRows
  });
  registerModelSchemaAndGc<Stored>({
    modelId: config.id,
    modelName: config.name,
    fields: config.fields,
    scopes: config.scopes as Record<string, ScopeSpec<Stored>> | undefined,
    gc: config.gc,
    dropIdleScopesAfterMs: config.maintenance?.dropIdleScopesAfterMs,
    context
  });

  const makeScopeHandle = createModelScopeHandle<Stored, Input>({
    modelId: config.id,
    modelName: config.name,
    context,
    scopes: config.scopes as Record<string, ScopeSpec<Stored>> | undefined,
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

  let consumerResetSequence = 0;
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)])) as {
    [K in keyof TScopes]: ScopeHandle<Stored, ScopeValueOf<TScopes[K]>, Input>;
  };

  const model: ModelCore<Stored, Input> & { scopes: typeof scopeHandles } = {
    modelId: config.id,
    ...createModelDefinitions<Stored, Input>({ modelId: config.id, context }),
    ...createModelDirectAccess<Stored, Input>({
      modelId: config.id,
      context,
      defaultOrder: config.defaultOrder,
      matchesCriteria,
      applyEvent,
      planRows,
      planReplace,
      normalize
    }),
    use: createModelReactiveReads<Stored, Input>({
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
      registerKeyedReset(`model-consumer:${config.id}:${(consumerResetSequence += 1)}`, fn);
    }
  };
  context.setModel(model);
  registerModelRuntime<Stored, Input>({
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
    (model.use as Record<string, unknown>)[scopeName] = (extra?: DbWhere<Stored>) => {
      const criteria = extra ? ({ and: [spec.where, extra] } as DbWhere<Stored>) : spec.where;
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
  return Object.assign(model, statics) as Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, 'use' | 'scopes'> & {
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> &
      QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
    scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>> };
  } & TExt;
};
