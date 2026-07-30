"use strict";

import { defineModelRuntime } from "./defineModelRuntime.js";
import { useRelationLoadMore } from "./pagination.js";
import { readModelRelation, registerRelationTarget } from "../core/relations.js";
import { registerBootValidation } from "./bootValidations.js";
import { readRowOperationState, useRowOperationState } from "./rowOperationState.js";
import { getInternalModelHandle, registerInternalModelHandle } from "../core/internalHandles.js";
import { scalarFieldCodecs } from "../schema/fieldCodec.js";
import { useEffect } from 'react';
import { exactMutationVariables } from "./mutationVariables.js";
const localLoadingState = hasData => ({
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
const createLocalResult = (data, hasData, hasMore, loadMore) => ({
  data,
  loadingState: localLoadingState(hasData),
  error: null,
  hasMore,
  isFetchingMore: false,
  isPreviousData: false,
  loadMore,
  refresh: async () => {}
});
const createNamedRelation = (runtime, name, params, query, remoteType) => {
  const scope = runtime.scopes[name];
  if (query && remoteType === 'single') {
    const single = query;
    const read = () => single.read(params);
    return {
      read,
      fetch: async () => {
        await single.fetch(params);
      },
      seed: rows => runtime.seed(rows),
      use: options => {
        const result = single.use(params, {
          enabled: options?.enabled
        });
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
      count: () => read() === undefined ? 0 : 1,
      useCount: () => single.use(params).data === undefined ? 0 : 1,
      invalidate: () => {
        if (params !== null) single.invalidate(params);
      },
      issueSequence: () => {
        throw new Error('issueSequence requires an ordered relation');
      }
    };
  }
  const base = {
    read: () => params === null ? [] : scope.read(params),
    fetch: async () => {
      if (query) await query.fetch(params);
    },
    seed: rows => {
      if (params !== null) scope.seed(params, rows);
    },
    count: () => params === null ? 0 : scope.read(params).length,
    useCount: () => scope.useCount(params),
    invalidate: () => {
      if (params === null) return;
      if (query) query.invalidate(params);else scope.invalidate(params);
    },
    issueSequence: field => {
      if (params === null) throw new Error('issueSequence requires an active relation');
      return scope.issueSequence(params, field);
    }
  };
  if (query) {
    return {
      ...base,
      use: options => {
        const pageSize = options?.pageSize ?? Number.MAX_SAFE_INTEGER;
        const queryResult = query.use(params, {
          enabled: options?.enabled
        });
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
const createWhereRelation = (runtime, where, options) => ({
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
const createByIdsRelation = (runtime, ids) => ({
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
const createAssociationRelation = (runtime, name, id) => {
  const read = () => readModelRelation(runtime.modelId, id, name);
  const use = () => runtime.use.related(id, name);
  const count = data => Array.isArray(data) ? data.length : data === undefined ? 0 : 1;
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
const createOperation = (runtime, id) => ({
  read: () => readRowOperationState(runtime.modelId, id),
  use: () => useRowOperationState(runtime.modelId, id)
});
const createAction = (runtime, name, definition) => {
  const readActionId = value => {
    const id = scalarFieldCodecs.id.read(value);
    if (id === undefined) throw new Error(`${name}: action requires id`);
    return id;
  };
  if (definition.mode === 'durable') {
    if (!definition.optimistic) throw new Error(`${name}: durable insert requires optimistic build`);
    const insert = definition.optimistic;
    const handle = runtime.detached(name, {
      build: (input, context) => insert.build(input, context),
      resume: definition.resume,
      failure: insert.failure,
      onFailurePatch: insert.onFailurePatch ? input => insert.onFailurePatch(input) : undefined
    });
    return {
      run: handle.start,
      complete: handle.complete,
      fail: handle.fail,
      retry: handle.retry,
      discard: handle.discard
    };
  }
  if (definition.mode === 'poll') {
    const inputs = new Map();
    const refs = new Map();
    const poller = runtime.poller(name, {
      document: definition.document,
      vars: id => {
        return definition.variables(inputs.get(id), {
          tempId: null,
          operationId: ''
        });
      },
      apply: (id, data) => {
        const patch = definition.select(data);
        if (patch != null) runtime.update(id, patch);
      },
      classify: definition.poll.classify,
      intervalMs: definition.poll.intervalMs,
      maxAttempts: definition.poll.maxAttempts
    });
    const idFor = input => readActionId(definition.id(input));
    const retain = id => {
      refs.set(id, (refs.get(id) ?? 0) + 1);
    };
    const release = id => {
      const next = refs.get(id) - 1;
      if (next > 0) {
        refs.set(id, next);
        return;
      }
      refs.delete(id);
      inputs.delete(id);
    };
    return {
      run: async input => {
        const id = idFor(input);
        inputs.set(id, input);
        try {
          await poller.refresh(id);
        } finally {
          if (!refs.has(id)) inputs.delete(id);
        }
      },
      use: input => {
        const id = input == null ? null : idFor(input);
        if (id) inputs.set(id, input);
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
          ...(id ? phase : {
            phase: 'idle',
            attempts: 0
          }),
          refresh: async () => {
            if (!id || input == null) return;
            inputs.set(id, input);
            await poller.refresh(id, {
              resetBudget: true
            });
          }
        };
      }
    };
  }
  const optimistic = (() => {
    if (definition.kind === 'insert' && definition.optimistic) {
      const insert = definition.optimistic;
      return {
        model: runtime,
        build: (input, context) => {
          return insert.build(input, {
            ...context,
            tempId: context.tempId
          });
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
        method: 'patch',
        model: runtime,
        selectId: input => readActionId(definition.id(input)),
        selectPatch: definition.optimistic.patch
      };
    }
    if (definition.kind === 'destroy' && definition.optimistic === true) {
      return {
        method: 'destroy',
        model: runtime,
        selectId: input => readActionId(definition.id(input))
      };
    }
    return undefined;
  })();
  const extract = definition.kind === 'update' ? ({
    data
  }) => {
    const row = definition.select(data);
    return row == null ? [] : [{
      into: runtime,
      rows: [row]
    }];
  } : definition.kind === 'custom' && definition.select ? ({
    data
  }) => {
    const row = definition.select?.(data);
    return row == null ? [] : [{
      into: runtime,
      rows: [row]
    }];
  } : undefined;
  const mutationConfig = {
    document: definition.document,
    result: definition.result,
    [exactMutationVariables]: definition.variables,
    optimistic,
    extract,
    dedupe: definition.dedupe,
    once: definition.once,
    onMutate: definition.before,
    onCommit: definition.after ? (data, context) => definition.after?.({
      input: context.input,
      data
    }) : undefined,
    onError: definition.error,
    invalidate: definition.invalidate,
    track: definition.track
  };
  const mutation = runtime.mutation(name, mutationConfig);
  return {
    run: input => mutation.run(input),
    retry: tempId => mutation.retry(tempId),
    discard: tempId => mutation.discard(tempId),
    use: () => {
      const handle = mutation.use();
      return {
        run: input => handle.mutateAsync(input),
        isPending: handle.isPending,
        error: handle.error
      };
    }
  };
};
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
  const compiledRelations = Object.fromEntries(Object.entries(config.relations ?? {}).map(([name, definition]) => {
    const remote = definition.remote;
    const query = remote ? remote.type === 'single' ? runtime.query(name, {
      document: remote.document,
      vars: remote.variables,
      select: remote.select,
      into: runtime,
      requiredScope: remote.required,
      staleTime: remote.staleTime,
      resumeStaleTime: remote.resumeStaleTime,
      emptyStaleTime: remote.emptyStaleTime,
      refetchOnMount: remote.refetchOnMount
    }) : remote.type === 'list' ? (() => {
      const list = remote;
      return runtime.query(name, {
        document: list.document,
        vars: list.variables,
        select: data => (list.select(data) ?? []).flatMap(node => node == null ? [] : [list.map ? list.map(node) : node]),
        into: runtime.scopes[name],
        coverage: 'complete',
        requiredScope: list.required,
        staleTime: list.staleTime,
        resumeStaleTime: list.resumeStaleTime,
        emptyStaleTime: list.emptyStaleTime,
        refetchOnMount: list.refetchOnMount
      });
    })() : (() => {
      const connection = remote;
      return runtime.query(name, {
        document: connection.document,
        vars: connection.variables,
        page: data => {
          const value = connection.connection(data);
          const nodes = value?.nodes ? [...value.nodes].filter(node => node != null) : (value?.edges ?? []).flatMap(edge => edge?.node == null ? [] : [edge.node]);
          return {
            nodes: connection.map ? nodes.map(node => connection.map(node)) : nodes,
            pageInfo: value?.pageInfo,
            relationCursor: value && connection.cursor ? connection.cursor(data, value) : undefined
          };
        },
        into: runtime.scopes[name],
        coverage: connection.coverage,
        requiredScope: connection.required,
        staleTime: connection.staleTime,
        resumeStaleTime: connection.resumeStaleTime,
        emptyStaleTime: connection.emptyStaleTime,
        refetchOnMount: connection.refetchOnMount,
        maxPages: connection.maxPages,
        direction: connection.direction,
        cursorVar: connection.cursorVar,
        getCursor: connection.cursor ? page => page.relationCursor ?? null : undefined,
        mapCursor: connection.mapCursor
      });
    })() : undefined;
    return [name, query];
  }));
  const relationMethods = Object.create(null);
  for (const name of Object.keys(config.relations ?? {})) {
    Reflect.set(relationMethods, name, params => createNamedRelation(runtime, name, params, compiledRelations[name], config.relations?.[name]?.remote?.type));
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