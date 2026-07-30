import type {
  ModelAction,
  ActionPayload,
  AssociationData,
  AssociationStored,
  ModelBuildInput,
  ModelAssociationMethods,
  ModelFacadeCore,
  ModelFacadeBase,
  ModelFacade,
  ModelFacadeConfig,
  ModelActionMethods,
  ModelRelationMethods,
  RowOperation,
  Relation,
  RelationDecl,
  RelationResult,
  ModelStoredValue,
  AnyFields,
  DbReadOptions,
  DbShape,
  FacadeRuntimeModel,
  DbWhere,
  GraphqlActionDefinition,
  LoadingState,
  RelationSpec,
  ScopeQueryHandle
} from '../types';
import { defineModelRuntime } from './defineModelRuntime';
import { useRelationLoadMore } from './pagination';
import { readModelRelation } from '../core/relations';
import { registerBootValidation } from './bootValidations';
import { readRowOperationState, useRowOperationState } from './rowOperationState';

const localLoadingState = (hasData: boolean): LoadingState => ({
  phase: 'ready',
  hasData,
  isReady: true,
  showSkeleton: false,
  showData: hasData,
  showEmptyState: !hasData,
  showRefreshIndicator: false,
  showFooterSpinner: false,
  showErrorBanner: false,
  isRetrying: false,
  retryAttempt: 0,
  isOffline: false
});

const createLocalResult = <TData>(data: TData, hasData: boolean, hasMore: boolean, loadMore: () => void): RelationResult<TData> => ({
  data,
  loadingState: localLoadingState(hasData),
  error: null,
  hasMore,
  loadMore,
  refresh: async () => {}
});

const createNamedRelation = <TStored extends { id: string }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  name: string,
  params: Record<string, unknown>,
  query: ScopeQueryHandle<TStored, Record<string, unknown>> | undefined
): Relation<TStored> => {
  const scope = runtime.scopes[name]!;
  const base = {
    read: () => scope.read(params),
    count: () => scope.read(params).length,
    useCount: () => scope.useCount(params),
    invalidate: () => {
      if (query) query.invalidate(params);
      else scope.invalidate(params);
    },
    issueSequence: (field: keyof TStored & string) => scope.issueSequence(params, field)
  };
  if (query) {
    return {
      ...base,
      use: options => {
        const pageSize = options?.pageSize ?? Number.MAX_SAFE_INTEGER;
        const queryResult = query.use(params, { enabled: options?.enabled });
        const window = scope.useWindow(params, {
          pageSize,
          renderKeys: options?.renderKeys,
          require: options?.require,
          keepPrevious: options?.keepPrevious
        });
        const loadMore = useRelationLoadMore(window, queryResult, {
          debounceMs: options?.loadMoreDebounceMs,
          enabled: options?.enabled
        });
        return {
          data: window.rows,
          loadingState: queryResult.loadingState,
          error: queryResult.error,
          hasMore: window.hasMore || queryResult.hasNextPage,
          loadMore,
          refresh: async () => {
            await query.fetch(params);
          }
        };
      }
    };
  }
  return {
    ...base,
    use: options => {
      const pageSize = options?.pageSize ?? Number.MAX_SAFE_INTEGER;
      const result = scope.useWindow(params, {
        pageSize,
        renderKeys: options?.renderKeys,
        require: options?.require,
        keepPrevious: options?.keepPrevious
      });
      return createLocalResult(result.rows, result.rows.length > 0, result.hasMore, result.fetchNextPage);
    }
  };
};

const createWhereRelation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  where: DbWhere<TStored>,
  options?: DbReadOptions<TStored>
): Relation<TStored> => ({
  read: () => runtime.where(where, options),
  use: () => {
    let builder = runtime.use.where(where);
    const order = options?.orderBy;
    if (order && 'field' in order) builder = builder.orderBy(order.field, order.direction);
    if (options?.limit !== undefined) builder = builder.limit(options.limit);
    const rows = builder.rows();
    return createLocalResult(rows, rows.length > 0, false, () => {});
  },
  count: () => runtime.where(where).length,
  useCount: () => runtime.use.count(where),
  invalidate: () => runtime.invalidate(where),
  issueSequence: () => {
    throw new Error('issueSequence requires a named relation');
  }
});

const createByIdsRelation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  ids: readonly string[] | null | undefined
): Relation<TStored> => ({
  read: () => (ids ?? []).flatMap(id => {
    const row = runtime.find(id);
    return row ? [row] : [];
  }),
  use: () => {
    const rows = runtime.use.byIds(ids).rows;
    return createLocalResult(rows, rows.length > 0, false, () => {});
  },
  count: () => (ids ?? []).reduce((count, id) => count + (runtime.find(id) ? 1 : 0), 0),
  useCount: () => runtime.use.byIds(ids).rows.length,
  invalidate: () => {
    for (const id of ids ?? []) runtime.invalidate({ id });
  },
  issueSequence: () => {
    throw new Error('issueSequence requires a named relation');
  }
});

const createAssociationRelation = <
  TStored extends { id: string; updatedAt?: string | null },
  TInput,
  TDefinition extends RelationDecl<unknown>
>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  name: string,
  id: string | null | undefined
): Relation<AssociationStored<TDefinition>, AssociationData<TDefinition>> => {
  const read = (): AssociationData<TDefinition> => readModelRelation<AssociationData<TDefinition>>(runtime.modelId, id, name);
  const use = (): AssociationData<TDefinition> => runtime.use.related(id, name) as AssociationData<TDefinition>;
  const count = (data: AssociationData<TDefinition>): number => (Array.isArray(data) ? data.length : data === undefined ? 0 : 1);
  return {
    read,
    use: () => {
      const data = use();
      return createLocalResult(data, count(data) > 0, false, () => {});
    },
    count: () => count(read()),
    useCount: () => count(use()),
    invalidate: () => {},
    issueSequence: () => {
      throw new Error('issueSequence requires a named relation');
    }
  };
};

const createOperation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  id: string | null | undefined
): RowOperation<TStored> => ({
  read: () => readRowOperationState<TStored>(runtime.modelId, id),
  use: () => useRowOperationState<TStored>(runtime.modelId, id)
});

const createAction = <TStored extends { id: string; updatedAt?: string | null }, TInput, TDefinition extends GraphqlActionDefinition<any, any, any, any, any>>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  name: string,
  definition: TDefinition
): ModelAction<Parameters<TDefinition['variables']>[0], ActionPayload<TDefinition>> => {
  if ((definition.mode ?? 'request') !== 'request') {
    throw new Error(`${name}: durable and poll action modes require their dedicated runtime compiler`);
  }
  const optimistic = (() => {
    if (definition.kind === 'insert' && definition.optimistic) {
      const insert = definition.optimistic;
      return {
        model: runtime,
        build: (input: Parameters<TDefinition['variables']>[0], context: { tempId: string | null; operationId: string }) => {
          if (context.tempId === null) throw new Error(`${name}: insert action requires a temp id`);
          return insert.build(input, { ...context, tempId: context.tempId });
        },
        selectServerNode: definition.select,
        existingTempId: insert.existingTempId,
        failure: insert.failure,
        onFailurePatch: insert.onFailurePatch,
        onRetryPatch: insert.onRetryPatch,
        correlate: insert.correlate
      };
    }
    if (definition.kind === 'update' && definition.optimistic) {
      return {
        method: 'patch' as const,
        model: runtime,
        selectId: definition.optimistic.id,
        selectPatch: definition.optimistic.patch
      };
    }
    if (definition.kind === 'destroy' && definition.optimistic === true) {
      return {
        method: 'destroy' as const,
        model: runtime,
        selectId: definition.id
      };
    }
    return undefined;
  })();
  const extract =
    definition.kind === 'update'
      ? ({ data }: { data: Parameters<typeof definition.select>[0] }) => {
          const row = definition.select(data);
          return row == null ? [] : [{ into: runtime, rows: [row] }];
        }
      : definition.kind === 'custom' && definition.select
        ? ({ data }: { data: Parameters<NonNullable<typeof definition.select>>[0] }) => {
            const row = definition.select?.(data);
            return row == null ? [] : [{ into: runtime, rows: [row] }];
          }
        : undefined;
  const mutation = runtime.mutation(name, {
    document: definition.document,
    result: definition.result,
    mapInput: definition.variables,
    optimistic,
    extract,
    dedupe: definition.dedupe,
    once: definition.once,
    invalidate: definition.invalidate,
    track: definition.track
  });
  return {
    run: input => mutation.run(input) as Promise<ActionPayload<TDefinition> | null>,
    retry: tempId => mutation.retry(tempId) as Promise<ActionPayload<TDefinition> | null>,
    discard: tempId => mutation.discard(tempId),
    use: () => {
      const handle = mutation.use();
      return {
        run: input => handle.mutateAsync(input) as Promise<ActionPayload<TDefinition> | null>,
        isPending: handle.isPending,
        error: handle.error
      };
    }
  };
};

export const defineModelFacade = <
  const TKey extends string,
  TShape extends DbShape<any, AnyFields>,
  const TRelations extends Record<string, RelationSpec<ModelStoredValue<TShape>, any>>,
  const TActions extends Record<string, GraphqlActionDefinition<any, any, any, any, any>>,
  const TAssociations extends Record<string, RelationDecl<unknown>>,
  TStatics extends Record<string, unknown>
>(
  key: TKey,
  config: ModelFacadeConfig<TShape, TRelations, TActions, TAssociations, TStatics>
): ModelFacade<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TAssociations, TStatics> => {
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

  const compiledRelations = Object.fromEntries(
    Object.entries(config.relations ?? {}).map(([name, definition]) => {
      const remote = definition.remote;
      const query = remote
        ? (runtime.query(name, {
            document: remote.document,
            vars: remote.variables,
            connection: remote.connection,
            into: runtime.scopes[name] as never,
            requiredScope: remote.required,
            staleTime: remote.staleTime,
            resumeStaleTime: remote.resumeStaleTime,
            emptyStaleTime: remote.emptyStaleTime,
            refetchOnMount: remote.refetchOnMount,
            maxPages: remote.maxPages,
            direction: remote.direction,
            cursorVar: remote.cursorVar
          }) as ScopeQueryHandle<ModelStoredValue<TShape>, Record<string, unknown>>)
        : undefined;
      return [name, query] as const;
    })
  );
  const relationMethods: ModelRelationMethods<ModelStoredValue<TShape>, TRelations> = Object.create(null);
  for (const name of Object.keys(config.relations ?? {})) {
    Reflect.set(relationMethods, name, (params: Record<string, unknown>) => createNamedRelation(runtime, name, params, compiledRelations[name]));
  }
  const actions: ModelActionMethods<TActions> = Object.create(null);
  for (const [name, definition] of Object.entries(config.actions ?? {})) {
    Reflect.set(actions, name, createAction(runtime, `${key}:${name}`, definition));
  }
  const base: ModelFacadeCore<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TActions> = {
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
    actions
  };
  const modelBase: ModelFacadeBase<ModelStoredValue<TShape>, ModelBuildInput<TShape>, TRelations, TActions, TAssociations> = Object.assign(
    base,
    relationMethods,
    Object.create(null) as ModelAssociationMethods<TAssociations>
  );
  const associationMethods = new Map<string, (id: string | null | undefined) => Relation<any, any>>();
  let associationsValidated = false;
  const validateAssociations = (): void => {
    if (associationsValidated) return;
    for (const name of Object.keys(associations())) {
      if (Reflect.has(modelBase, name) || name in (config.actions ?? {})) {
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
      if (property in (config.actions ?? {})) throw new Error(`${key}: association ${property} collides with an action`);
      const existing = associationMethods.get(property);
      if (existing) return existing;
      const method = (id: string | null | undefined) =>
        createAssociationRelation<ModelStoredValue<TShape>, ModelBuildInput<TShape>, typeof definition>(runtime, property, id);
      associationMethods.set(property, method);
      return method;
    }
  });
  const statics = config.statics?.(model) ?? ({} as TStatics);
  for (const name of Object.keys(statics)) {
    if (name in model) throw new Error(`${key}: static ${name} collides with the model surface`);
  }
  return Object.assign(model, statics);
};
