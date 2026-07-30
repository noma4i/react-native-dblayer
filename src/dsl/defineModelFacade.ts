import type {
  ActionPayload,
  ActionInput,
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
  GraphqlConnectionDefinition,
  GraphqlListDefinition,
  GraphqlLiveDefinition,
  LoadingState,
  QueryHandle,
  RelationCursorPage,
  RelationSpec,
  ScopeQueryHandle
} from '../types';
import { defineModelRuntime } from './defineModelRuntime';
import { useRelationLoadMore } from './pagination';
import { readModelRelation, registerRelationTarget } from '../core/relations';
import { registerBootValidation } from './bootValidations';
import { readRowOperationState, useRowOperationState } from './rowOperationState';
import { getInternalModelHandle, registerInternalModelHandle } from '../core/internalHandles';
import { scalarFieldCodecs } from '../schema/fieldCodec';
import { useEffect } from 'react';

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
  isFetchingMore: false,
  isPreviousData: false,
  loadMore,
  refresh: async () => {}
});

const createNamedRelation = <TStored extends { id: string }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  name: string,
  params: Record<string, unknown> | null,
  query: ScopeQueryHandle<TStored, Record<string, unknown>> | QueryHandle<TStored, Record<string, unknown>, TStored | undefined> | undefined,
  remoteType: 'connection' | 'list' | 'single' | undefined
): Relation<TStored, TStored[] | TStored | undefined, TInput> => {
  const scope = runtime.scopes[name]!;
  if (query && remoteType === 'single') {
    const single = query as QueryHandle<TStored, Record<string, unknown>, TStored | undefined>;
    const read = (): TStored | undefined => single.read(params);
    return {
      read,
      fetch: async () => {
        await single.fetch(params);
      },
      seed: rows => runtime.seed(rows),
      use: options => {
        const result = single.use(params, { enabled: options?.enabled });
        return {
          data: result.data,
          loadingState: result.loadingState,
          error: result.error,
          hasMore: false,
          isFetchingMore: false,
          isPreviousData: false,
          loadMore: () => {},
          refresh: async () => {
            await single.fetch(params);
          }
        };
      },
      count: () => (read() === undefined ? 0 : 1),
      useCount: () => (single.use(params).data === undefined ? 0 : 1),
      invalidate: () => {
        if (params !== null) single.invalidate(params);
      },
      issueSequence: () => {
        throw new Error('issueSequence requires an ordered relation');
      }
    };
  }
  const base = {
    read: () => (params === null ? [] : scope.read(params)),
    fetch: async () => {
      if (query) await query.fetch(params);
    },
    seed: (rows: TInput[]) => {
      if (params !== null) scope.seed(params, rows);
    },
    count: () => (params === null ? 0 : scope.read(params).length),
    useCount: () => scope.useCount(params),
    invalidate: () => {
      if (params === null) return;
      if (query) query.invalidate(params);
      else scope.invalidate(params);
    },
    issueSequence: (field: keyof TStored & string) => {
      if (params === null) throw new Error('issueSequence requires an active relation');
      return scope.issueSequence(params, field);
    }
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
          isFetchingMore: queryResult.isFetchingNextPage,
          isPreviousData: window.isPreviousData,
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
): Relation<TStored, TStored[], TInput> => ({
  read: () => runtime.where(where, options),
  fetch: async () => {},
  seed: rows => runtime.seed(rows),
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
  invalidate: () => {},
  issueSequence: () => {
    throw new Error('issueSequence requires a named relation');
  }
});

const createByIdsRelation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  ids: readonly string[] | null | undefined
): Relation<TStored, TStored[], TInput> => ({
  read: () => (ids ?? []).flatMap(id => {
    const row = runtime.find(id);
    return row ? [row] : [];
  }),
  fetch: async () => {},
  seed: rows => runtime.seed(rows),
  use: () => {
    const rows = runtime.use.byIds(ids).rows;
    return createLocalResult(rows, rows.length > 0, false, () => {});
  },
  count: () => (ids ?? []).reduce((count, id) => count + (runtime.find(id) ? 1 : 0), 0),
  useCount: () => runtime.use.byIds(ids).rows.length,
  invalidate: () => {},
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
    fetch: async () => {},
    seed: () => {
      throw new Error('seed requires a model relation');
    },
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
): ModelActionMethods<Record<'defined', TDefinition>>['defined'] => {
  const readActionId = (value: unknown): string => {
    const id = scalarFieldCodecs.id.read(value);
    if (id === undefined) throw new Error(`${name}: action requires id`);
    return id;
  };
  if (definition.mode === 'durable') {
    if (!definition.optimistic) throw new Error(`${name}: durable insert requires optimistic build`);
    const insert = definition.optimistic;
    const handle = runtime.detached<ActionInput<TDefinition>>(name, {
      build: (input, context) => insert.build(input, context) as TStored,
      resume: definition.resume,
      failure: insert.failure,
      onFailurePatch: insert.onFailurePatch ? input => insert.onFailurePatch!(input) as Partial<TStored> : undefined
    });
    return {
      run: handle.start,
      complete: handle.complete,
      fail: handle.fail,
      retry: handle.retry,
      discard: handle.discard
    } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
  }
  if (definition.mode === 'poll') {
    const inputs = new Map<string, ActionInput<TDefinition>>();
    const refs = new Map<string, number>();
    const poller = runtime.poller<Parameters<typeof definition.select>[0]>(name, {
      document: definition.document,
      vars: id => {
        return definition.variables(inputs.get(id)!, { tempId: null, operationId: '' });
      },
      apply: (id, data) => {
        const patch = definition.select(data);
        if (patch != null) runtime.update(id, patch as Partial<TStored>);
      },
      classify: definition.poll.classify,
      intervalMs: definition.poll.intervalMs,
      maxAttempts: definition.poll.maxAttempts
    });
    const idFor = (input: ActionInput<TDefinition>): string => readActionId(definition.id(input));
    const retain = (id: string): void => {
      refs.set(id, (refs.get(id) ?? 0) + 1);
    };
    const release = (id: string): void => {
      const next = refs.get(id)! - 1;
      if (next > 0) {
        refs.set(id, next);
        return;
      }
      refs.delete(id);
      inputs.delete(id);
    };
    return {
      run: async (input: ActionInput<TDefinition>) => {
        const id = idFor(input);
        inputs.set(id, input);
        try {
          await poller.refresh(id);
        } finally {
          if (!refs.has(id)) inputs.delete(id);
        }
      },
      use: (input: ActionInput<TDefinition> | null) => {
        const id = input == null ? null : idFor(input);
        if (id) inputs.set(id, input!);
        const phase = poller.usePhase(id ?? `${name}:inactive`);
        useEffect(() => {
          if (!id) return;
          retain(id);
          const detach = poller.attach(id);
          return () => {
            detach();
            release(id);
          };
        }, [id]);
        return {
          ...(id ? phase : { phase: 'idle' as const, attempts: 0 }),
          refresh: async () => {
            if (!id || input == null) return;
            inputs.set(id, input);
            await poller.refresh(id, { resetBudget: true });
          }
        };
      }
    } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
  }
  const optimistic = (() => {
    if (definition.kind === 'insert' && definition.optimistic) {
      const insert = definition.optimistic;
      return {
        model: runtime,
        build: (input: Parameters<TDefinition['variables']>[0], context: { tempId: string | null; operationId: string }) => {
          return insert.build(input, { ...context, tempId: context.tempId! });
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
        selectId: (input: ActionInput<TDefinition>) => readActionId(definition.id(input)),
        selectPatch: definition.optimistic.patch
      };
    }
    if (definition.kind === 'destroy' && definition.optimistic === true) {
      return {
        method: 'destroy' as const,
        model: runtime,
        selectId: (input: ActionInput<TDefinition>) => readActionId(definition.id(input))
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
    onMutate: definition.before,
    onCommit: definition.after ? (data, context) => definition.after?.({ input: context.input, data }) : undefined,
    onError: definition.error,
    invalidate: definition.invalidate,
    track: definition.track
  });
  return {
    run: (input: ActionInput<TDefinition>) => mutation.run(input) as Promise<ActionPayload<TDefinition> | null>,
    retry: tempId => mutation.retry(tempId) as Promise<ActionPayload<TDefinition> | null>,
    discard: tempId => mutation.discard(tempId),
    use: () => {
      const handle = mutation.use();
      return {
        run: (input: ActionInput<TDefinition>) => handle.mutateAsync(input) as Promise<ActionPayload<TDefinition> | null>,
        isPending: handle.isPending,
        error: handle.error
      };
    }
  } as ModelActionMethods<Record<'defined', TDefinition>>['defined'];
};

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

  const compiledRelations = Object.fromEntries(
    Object.entries(config.relations ?? {}).map(([name, definition]) => {
      const remote = definition.remote;
      const query = remote
        ? remote.type === 'single'
          ? (runtime.query(name, {
              document: remote.document,
              vars: remote.variables,
              select: remote.select,
              into: runtime,
              requiredScope: remote.required,
              staleTime: remote.staleTime,
              resumeStaleTime: remote.resumeStaleTime,
              emptyStaleTime: remote.emptyStaleTime,
              refetchOnMount: remote.refetchOnMount
            }) as QueryHandle<ModelStoredValue<TShape>, Record<string, unknown>, ModelStoredValue<TShape> | undefined>)
          : remote.type === 'list'
            ? (() => {
                const list = remote as GraphqlListDefinition<any, any, any, any, any>;
                return runtime.query(name, {
                  document: list.document,
                  vars: list.variables,
                  select: (data: unknown) => (list.select(data) ?? []).flatMap(node => (node == null ? [] : [list.map ? list.map(node) : node])),
                  into: runtime.scopes[name] as never,
                  coverage: 'complete',
                  requiredScope: list.required,
                  staleTime: list.staleTime,
                  resumeStaleTime: list.resumeStaleTime,
                  emptyStaleTime: list.emptyStaleTime,
                  refetchOnMount: list.refetchOnMount
                }) as ScopeQueryHandle<ModelStoredValue<TShape>, Record<string, unknown>>;
              })()
            : (() => {
                const connection = remote as GraphqlConnectionDefinition<any, any, any, any, any, any>;
                return runtime.query(name, {
                  document: connection.document,
                  vars: connection.variables,
                  page: (data: unknown): RelationCursorPage => {
                    const value = connection.connection(data);
                    const nodes = value?.nodes
                      ? [...value.nodes].filter((node: unknown) => node != null)
                      : (value?.edges ?? []).flatMap((edge: { node?: unknown } | null | undefined) => (edge?.node == null ? [] : [edge.node]));
                    return {
                      nodes: connection.map ? nodes.map((node: unknown) => connection.map!(node)) : nodes,
                      pageInfo: value?.pageInfo,
                      relationCursor: value && connection.cursor ? connection.cursor(data, value) : undefined
                    };
                  },
                  into: runtime.scopes[name] as never,
                  coverage: connection.coverage,
                  requiredScope: connection.required,
                  staleTime: connection.staleTime,
                  resumeStaleTime: connection.resumeStaleTime,
                  emptyStaleTime: connection.emptyStaleTime,
                  refetchOnMount: connection.refetchOnMount,
                  maxPages: connection.maxPages,
                  direction: connection.direction,
                  cursorVar: connection.cursorVar,
                  getCursor: connection.cursor ? page => (page as RelationCursorPage).relationCursor ?? null : undefined,
                  mapCursor: connection.mapCursor
                }) as ScopeQueryHandle<ModelStoredValue<TShape>, Record<string, unknown>>;
              })()
        : undefined;
      return [name, query] as const;
    })
  );
  const relationMethods: ModelRelationMethods<ModelStoredValue<TShape>, TRelations, ModelBuildInput<TShape>> = Object.create(null);
  for (const name of Object.keys(config.relations ?? {})) {
    Reflect.set(relationMethods, name, (params: Record<string, unknown> | null) =>
      createNamedRelation(runtime, name, params, compiledRelations[name], config.relations?.[name]?.remote?.type)
    );
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
