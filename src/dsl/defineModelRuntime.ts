import type {
  DbWhere,
  InferBuildInput,
  InferStoredFields,
  ModelFieldSpecs,
  ModelLandingOptions,
  ModelConfig,
  ModelCore,
  QueryScopeReads,
  QueryScopeSpec,
  RequiredReadUse,
  ScopeHandle,
  ScopeSpec,
  WriteOp
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
import { planModelLanding, planModelLandingWithRoot, registerModelLandingHost } from './modelLandingGraph';
/**
 * Define a persistent, reactive collection model backed by `EntityState` and the shared journalled
 * apply pipeline. State planes (entity rows and scope membership) are created and hydrated from storage
 * lazily on first touch, so models can be declared at module scope before `configureDb` runs.
 *
 * @param config Field specs, id/guard resolution, optional relations/scopes, gc/write policy, and statics.
 * @returns A `ModelCore` (snapshot reads, `use.*` reactive reads, `update`/`destroy`/`insert`, `related`)
 * plus a `scopes` map of `ScopeHandle`s (one per configured scope) and any `statics` the config builds.
 */
export const defineModelRuntime = <
  const TFields extends ModelFieldSpecs,
  TScopeNames extends string = never,
  TExt extends Record<string, unknown> = {},
  TQueryScopeNames extends string = never
>(
  config: ModelConfig<TFields, TScopeNames, TExt, TQueryScopeNames>,
  landing?: ModelLandingOptions
): Omit<ModelCore<InferStoredFields<TFields>, InferBuildInput<TFields>>, 'use' | 'scopes'> & {
  use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> &
    QueryScopeReads<InferStoredFields<TFields>, TQueryScopeNames>;
  scopes: { [K in TScopeNames]: ScopeHandle<InferStoredFields<TFields>, Record<string, unknown>, InferBuildInput<TFields>> };
} & TExt => {
  const { applyWriteGate, isPlanRow, normalize } = createModelNormalization(config);
  const context = createModelContext<InferStoredFields<TFields> & Record<string, unknown>>({
    modelId: config.id,
    scopeNames: Object.keys(config.scopes ?? {}),
    relations: () => config.relations?.() ?? {},
    applyWriteGate
  });
  const { planes, resolvedRelations } = context;

  const scopeSpecs = (config.scopes ?? {}) as Record<string, ScopeSpec<InferStoredFields<TFields> & Record<string, unknown>>>;
  const membershipScopes = Object.entries(scopeSpecs).flatMap(([name, spec]) => (spec.by ? [[name, { ...spec, by: spec.by }] as const] : []));

  const scopeByFieldMap = new Map(membershipScopes.map(([name, spec]) => [name, spec.by] as const));
  const { keyForScope, normalizeScopeValue, isScopeValueComplete, scopeValueFromRow } = createModelScopeKeys(config, scopeByFieldMap);
  const { matches: matchesCriteria, normalize: normalizeCriteria } = createModelCriteria<InferStoredFields<TFields> & Record<string, unknown>>(config.fields);

  const { membershipForUpsert, detachForDestroy } = createModelMembership<InferStoredFields<TFields> & Record<string, unknown>>({
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

  const captureMembership = (id: string): Array<{ id: string; scopeKey: string; orderKey: string }> =>
    planes()
      .scopeIndex.keysOf(id)
      .map(scopeKey => ({
        id,
        scopeKey,
        orderKey: planes()
          .scopeIndex.read(scopeKey)
          .entries.find(candidate => candidate.id === id)!.orderKey
      }));
  const { prepareRow, preparePatch, putRows, planRows: planOwnRows, planReplace: planOwnReplace, planRestore } = createModelWrites<
    InferStoredFields<TFields> & Record<string, unknown>
  >({
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
  const planRows = landing
    ? (rows: unknown[], planOptions?: { origin?: 'event' }): WriteOp[] => planModelLanding(config.id, rows, planOptions)
    : planOwnRows;
  const planReplace = landing
    ? (oldId: string, next: unknown): WriteOp[] =>
        planModelLandingWithRoot(config.id, [next], rows => planOwnReplace(oldId, rows[0]))
    : planOwnReplace;

  const { rowDep, modelDep, useScopeAccess, scopeSortedRows, whereRead } = createModelReadAccess<
    InferStoredFields<TFields> & Record<string, unknown>
  >({
    modelId: config.id,
    context,
    scopes: config.scopes as Record<string, ScopeSpec<InferStoredFields<TFields> & Record<string, unknown>>> | undefined,
    defaultOrder: config.defaultOrder,
    keyForScope,
    matchesCriteria,
    normalizeCriteria
  });
  const { applyTarget, applySnapshot, applyEvent } = createModelApplyTarget<InferStoredFields<TFields> & Record<string, unknown>>({
    modelId: config.id,
    scopes: config.scopes as Record<string, ScopeSpec<InferStoredFields<TFields> & Record<string, unknown>>> | undefined,
    context,
    scopeSortedRows,
    prepareRow,
    preparePatch,
    putRows
  });
  registerModelSchemaAndGc<InferStoredFields<TFields> & Record<string, unknown>>({
    modelId: config.id,
    modelName: config.name,
    fields: config.fields,
    scopes: config.scopes as Record<string, ScopeSpec<InferStoredFields<TFields> & Record<string, unknown>>> | undefined,
    gc: config.gc,
    dropIdleScopesAfterMs: config.maintenance?.dropIdleScopesAfterMs,
    context
  });

  const makeScopeHandle = createModelScopeHandle<InferStoredFields<TFields> & Record<string, unknown>, InferBuildInput<TFields>>({
    modelId: config.id,
    modelName: config.name,
    context,
    scopes: config.scopes as Record<string, ScopeSpec<InferStoredFields<TFields> & Record<string, unknown>>> | undefined,
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
  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)])) as {
    [K in TScopeNames]: ScopeHandle<InferStoredFields<TFields> & Record<string, unknown>, Record<string, unknown>, InferBuildInput<TFields>>;
  };

  const model: ModelCore<InferStoredFields<TFields> & Record<string, unknown>, InferBuildInput<TFields>> & { scopes: typeof scopeHandles } = {
    modelId: config.id,
    ...createModelDefinitions<InferStoredFields<TFields> & Record<string, unknown>, InferBuildInput<TFields>>({ modelId: config.id, context }),
    ...createModelDirectAccess<InferStoredFields<TFields> & Record<string, unknown>, InferBuildInput<TFields>>({
      modelId: config.id,
      context,
      defaultOrder: config.defaultOrder,
      matchesCriteria,
      applyEvent,
      planRows,
      planReplace,
      normalize
    }),
    use: createModelReactiveReads<InferStoredFields<TFields> & Record<string, unknown>, InferBuildInput<TFields>>({
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
  registerModelRuntime<InferStoredFields<TFields> & Record<string, unknown>, InferBuildInput<TFields>>({
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

  const queryScopeSpecs = (config.queryScopes ?? {}) as Record<string, QueryScopeSpec<InferStoredFields<TFields> & Record<string, unknown>>>;
  for (const [scopeName, spec] of Object.entries(queryScopeSpecs)) {
    if (scopeName in model.use) throw new Error(`${config.name} queryScope '${scopeName}' collides with a built-in use key`);
    (model.use as Record<string, unknown>)[scopeName] = (extra?: DbWhere<InferStoredFields<TFields> & Record<string, unknown>>) => {
      const criteria = extra ? ({ and: [spec.where, extra] } as DbWhere<InferStoredFields<TFields> & Record<string, unknown>>) : spec.where;
      let builder = whereRead(criteria);
      if (spec.orderBy) builder = builder.orderBy(spec.orderBy.field as never, spec.orderBy.direction);
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
      QueryScopeReads<InferStoredFields<TFields>, TQueryScopeNames>;
    scopes: { [K in TScopeNames]: ScopeHandle<InferStoredFields<TFields>, Record<string, unknown>, InferBuildInput<TFields>> };
  } & TExt;
};
