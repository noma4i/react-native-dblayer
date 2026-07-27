import type { DbGraphQLDocument, DbWhere, ModelFieldSpecs } from '../types';
import { buildScopeKey } from '../core/compileDbWhere';
import { compositeKey } from '../core/serialize';
import { registerSchemaDeclaration } from '../core/schemaManifest';
import { createCommitEnvelope } from '../core/apply/transaction';
import { registerGcHost } from '../core/gc';
import { invalidateModel } from '../core/invalidationRegistry';
import { getDbLogger } from '../core/logger';
import { noteDataLoss } from '../core/diagnostics';
import { registerRelationHost, type RelationDecl } from '../core/relations';
import { registerReset } from '../core/reset';
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
import { limitRows, sortModelReadRows } from '../read/incrementalReadEngine';
import { getApplyRuntime, getOperationState } from './configure';
import { defineFetch } from './defineFetch';
import { clearFailedOptimisticMutation, defineMutation, type MutationConfig } from './defineMutation';
import { defineDetachedOperation, type DetachedOperationConfig, type DetachedOperationHandle } from './defineDetachedOperation';
import { defineQuery, type EnsuredRowQueryHandle, type QueryHandle } from './defineQuery';
import { defineView, type ViewConfig, type ViewHandle } from './defineView';
import { defineModelIngest, registerIngestModel, type ModelIngestEntry } from './defineIngest';
import type { DbSubscriptionEntry } from '../core/subscriptionRuntime';
import type { RequiredFields } from './readBuilder';
import type { ScopeSpec } from './scope';
import { useEffect } from 'react';
import type { InferBuildInput, InferStoredFields } from '../schema/infer';
import { getDbTransport } from '../core/transport';
import { createModelStatusPoller, type ModelStatusPoller } from '../utils/modelStatusPoller';
import { resolveStaleTempRows, trimRowsPerScope } from '../utils/modelMaintenance';
import { registerModelMaintenance, type MaintenanceReport } from './maintenanceRegistry';
import { createDbSubscriptionRuntime } from '../core/subscriptionRuntime';
import { registerInternalModelHandle } from '../core/internalHandles';

export type { GuardedOrigin, MonotonicSpec, NestedKeyPolicy, WriteCtx, WriteGroup, WriteOrigin, WritePolicy } from '../core/writePolicies';

import type {
  LiveQueryHandle,
  ModelConfig,
  ModelCore,
  ModelFetchConfig,
  ModelMutationConfig,
  ModelQueryConfig,
  QueryScopeReads,
  QueryScopeSpec,
  RequiredReadUse,
  ScopeHandle,
  ScopeValueOf,
  ScopeWindowResult,
} from '../types/dsl.model.types';

export type { LiveQueryHandle, ModelConfig, ModelCore, ScopeHandle, ScopeValueOf, ScopeWindowResult } from '../types/dsl.model.types';

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
  use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
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

  const captureMembership = (id: string): Array<{ id: string; scopeKey: string; order: number; edge?: Record<string, unknown> }> =>
    planes().scopeIndex.keysOf(id).flatMap(scopeKey => {
      const entry = planes().scopeIndex.read(scopeKey).entries.find(candidate => candidate.id === id);
      return entry ? [{ id, scopeKey, order: entry.order, edge: entry.edge }] : [];
    });
  const { writeRows, patchRow, planRows, planReplace, planRestore } = createModelWrites<Stored>({
    modelId: config.id,
    modelName: config.name,
    entityState: () => planes().entityState,
    normalize,
    isPlanRow,
    bumpRevision: context.bumpRevision,
    captureMembership
  });

  const { rowDep, modelDep, scopeDep, memberDeps, useScopeAccess, scopeSortedRows, whereRead } = createModelReadAccess<Stored>({
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
    writeRows,
    patchRow
  });
  registerSchemaDeclaration({
    id: config.id,
    name: config.name,
    fields: Object.fromEntries(Object.entries(config.fields).map(([name, field]) => [name, { kind: field.kind, mode: field.mode, hasDefault: field.hasDefault }])),
    scopes: Object.fromEntries(
      Object.entries(config.scopes ?? {}).map(([name, spec]) => {
        const by = spec.by ? Object.fromEntries(Object.entries(spec.by).map(([scopeField, rowField]) => [scopeField, String(rowField)])) : null;
        const sort = spec.member ? 'member' : !spec.sort || spec.sort === 'server-order' ? 'server-order' : 'field' in spec.sort ? `field:${String(spec.sort.field)}:${spec.sort.dir}` : 'comparator';
        return [name, { by, sort }];
      })
    )
  });
  registerGcHost(config.id, {
    modelId: config.id,
    exempt: config.gc === 'exempt',
    rowIds: () =>
      planes()
        .entityState.values()
        .map(row => String(row.id)),
    hasRow: id => planes().entityState.read(id) !== undefined,
    scopeKeys: () => planes().scopeIndex.keys(),
    scopeEntryIds: key =>
      planes()
        .scopeIndex.read(key)
        .entries.map(entry => entry.id),
    detachScopeEntries: (key, ids) => {
      planes().scopeIndex.detach(key, ids);
    },
    scopeEntryCount: key => planes().scopeIndex.read(key).entries.length,
    removeScope: key => {
      planes().scopeIndex.remove(key);
    },
    idleScopeAfterMs: () => config.maintenance?.dropIdleScopesAfterMs,
    scopeLastAccess: key => planes().scopeIndex.lastAccess(key),
    evict: id => planes().entityState.evict(id),
    referencesOf: id => {
      const row = planes().entityState.read(id);
      if (!row) return [];
      const out: Array<{ model: string; id: string }> = [];
      for (const relation of Object.values(resolvedRelations())) {
        if (relation.kind === 'belongsTo') {
          const value = row[relation.foreignKey];
          if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
        }
        if (relation.kind === 'references') {
          const raw = relation.ids(row);
          const list = Array.isArray(raw) ? raw : [raw];
          for (const value of list) {
            if (typeof value === 'string' && value.length > 0) out.push({ model: relation.model.modelId, id: value });
          }
        }
      }
      return out;
    }
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
    applySnapshot,
    applyEvent
  });

  const scopeHandles = Object.fromEntries(Object.keys(config.scopes ?? {}).map(name => [name, makeScopeHandle(name)])) as {
    [K in keyof TScopes]: ScopeHandle<Stored, ScopeValueOf<TScopes[K]>, Input>;
  };

  const model: ModelCore<Stored, Input> & { scopes: typeof scopeHandles } = {
    modelId: config.id,
    // The runtime branch adds `live` exactly when the overload's live config is present.
    query: ((name, queryConfig) => {
      const { live, ...queryOptions } = queryConfig;
      const handle = defineQuery({
        ...queryOptions,
        key: queryConfig.key ?? compositeKey(config.id, name),
        into: queryConfig.into ?? (model as NonNullable<typeof queryConfig.into>)
      });
      if (!live) return handle;
      const compiled = defineModelIngest(model, live);
      let runtime: ReturnType<typeof createDbSubscriptionRuntime> | null = null;
      let readers = 0;
      const sync = () => {
        if (readers === 0) return;
        runtime ??= createDbSubscriptionRuntime(compiled.entries);
        runtime.setActive(true);
      };
      model.registerReset(() => {
        runtime?.setActive(false);
        runtime = null;
        sync();
      });
      return {
        ...handle,
        use: (scope: unknown, options?: { enabled?: boolean }) => {
          const result = handle.use(scope as never, options);
          useEffect(() => {
            readers += 1;
            sync();
            return () => {
              readers -= 1;
              if (readers === 0) runtime?.setActive(false);
            };
          }, []);
          return result;
        },
        live: { apply: compiled.apply }
      };
    }) as ModelCore<Stored, Input>['query'],
    mutation: (name, mutationConfig) => {
      /** Mutation dedupe keys are idempotency identities, not scope bucket keys; scope validation belongs to scope handles and queries. */
      const dedupe = mutationConfig.dedupe === false ? false : (mutationConfig.dedupe ?? { key: input => compositeKey(config.id, name, buildScopeKey(input)) });
      return defineMutation({ ...mutationConfig, dedupe });
    },
    detached: (kind, detachedConfig) => defineDetachedOperation(model, kind, detachedConfig),
    fetch: <TData, TFetchInput, TSelected>(name: string, fetchConfig: ModelFetchConfig<TData, TFetchInput, TSelected>) =>
      defineFetch<TData, TFetchInput, TSelected>({ ...fetchConfig, key: fetchConfig.key ?? compositeKey(config.id, name) } as Parameters<
        typeof defineFetch<TData, TFetchInput, TSelected>
      >[0]),
    view: (name, viewConfig) => defineView(model, name, viewConfig),
    poller: (name, pollerConfig) =>
      createModelStatusPoller({
        ...pollerConfig,
        fetch: async id => {
          try {
            return (await getDbTransport().query({ query: pollerConfig.document, variables: pollerConfig.vars?.(id) ?? { id } })).data;
          } catch (error) {
            getDbLogger().error('Model.poller', 'fetch failed', { key: compositeKey(config.id, name), id, error });
            throw error;
          }
        }
      }),
    ingest: entries => defineModelIngest(model, entries),
    find: id => (id == null ? undefined : planes().entityState.read(String(id))),
    where: (where, options) => {
      const rows = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where));
      const order = options?.orderBy ?? config.defaultOrder;
      if (!order) return limitRows(rows, options?.limit);
      return sortModelReadRows(rows, [{ field: String(order.field), direction: order.direction }], options?.limit);
    },
    all: () => planes().entityState.values(),
    update: (id, patch) => applyEvent([{ kind: 'patch', model: config.id, id: String(id), patch: patch as Record<string, unknown> }]),
    destroy: id => applyEvent([{ kind: 'destroy', model: config.id, ids: [String(id)] }]),
    destroyMany: ids => applyEvent([{ kind: 'destroy', model: config.id, ids: ids.map(id => String(id)) }]),
    updateAll: (where, patch) => {
      const rows = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where));
      if (rows.length === 0) return 0;
      applyEvent(rows.map(row => ({ kind: 'patch', model: config.id, id: String(row.id), patch: patch as Record<string, unknown> })));
      return rows.length;
    },
    destroyAll: where => {
      const ids = planes()
        .entityState.values()
        .filter(row => matchesCriteria(row, where))
        .map(row => String(row.id));
      if (ids.length === 0) return 0;
      applyEvent([{ kind: 'destroy', model: config.id, ids }]);
      return ids.length;
    },
    insert: row => applyEvent([{ kind: 'upsert', model: config.id, rows: [row] }]),
    insertMany: rows => applyEvent([{ kind: 'upsert', model: config.id, rows }]),
    seed: rows => applyEvent(planRows(rows)),
    replace: (oldId, next) => applyEvent(planReplace(String(oldId), next)),
    build: input => normalize(input, true),
    normalize: input => normalize(input),
    invalidate: scope => {
      invalidateModel(config.id, scope);
    },
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
      registerReset(fn);
    }
  };
  registerInternalModelHandle(model, {
    readRow: id => planes().entityState.read(id),
    applyRows: rows => applySnapshot(planRows(rows)),
    applyPatch: (id, patch, operationId) => getApplyRuntime().commit(createCommitEnvelope([{ kind: 'patch', model: config.id, id: String(id), patch, operationId }])),
    planRows,
    planReplace,
    captureMembership,
    planRestore,
    relations: resolvedRelations,
    revision: context.revision,
    dropTempRowsAfterMs: () => config.maintenance?.dropTempRowsAfterMs
  });
  registerIngestModel(config.name, model);
  if (config.maintenance) {
    const pendingTempRows = (): MaintenanceReport[] => {
      const maxAgeMs = config.maintenance?.dropTempRowsAfterMs;
      if (maxAgeMs === undefined) return [];
      const protectedIds = new Set([
        ...getOperationState().pending().filter(operation => operation.model === config.id).flatMap(operation => operation.tempIds),
        ...modelProtectedTempIds()
      ]);
      const ids: string[] = [];
      resolveStaleTempRows(model, { maxAgeMs, protectedIds, onStale: row => ids.push(row.id) });
      if (ids.length === 0) return [];
      getApplyRuntime().commit(createCommitEnvelope([{ kind: 'destroy', model: config.id, ids, tombstone: false }]));
      for (const id of ids) clearFailedOptimisticMutation(config.id, id);
      noteDataLoss('stale-temp-row-expiry', config.id, ids.length);
      return [{ model: config.id, task: 'dropTempRows', affected: ids.length }];
    };
    const modelProtectedTempIds = (): ReadonlySet<string> => new Set(config.maintenance?.protectTempRows?.() ?? []);
    registerModelMaintenance(config.id, {
      boot: () => {
        const reports: MaintenanceReport[] = [];
        for (const task of config.maintenance?.maxRowsPerScope ?? []) {
          reports.push({ model: config.id, task: 'maxRowsPerScope', affected: trimRowsPerScope(model, task.scopeField, task.limit, task.compare, task.protect?.()) });
        }
        return [...reports, ...pendingTempRows()];
      },
      pendingTempRows,
      protectedTempIds: modelProtectedTempIds
    });
  }

  registerReset(() => {
    context.reset();
    // The apply target stays registered: a model must keep working after the kill-switch.
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
    use: RequiredReadUse<InferStoredFields<TFields>, Extract<keyof TFields, keyof InferStoredFields<TFields> & string> | 'id'> & QueryScopeReads<InferStoredFields<TFields>, TQueryScopes>;
    scopes: { [K in keyof TScopes]: ScopeHandle<InferStoredFields<TFields>, ScopeValueOf<TScopes[K]>, InferBuildInput<TFields>> };
  } & TExt;
};
