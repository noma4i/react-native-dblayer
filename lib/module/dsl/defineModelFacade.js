"use strict";

import { defineModelRuntime } from "./defineModelRuntime.js";
import { useRelationLoadMore } from "./pagination.js";
import { readModelRelation } from "../core/relations.js";
import { registerBootValidation } from "./bootValidations.js";
import { readRowOperationState, useRowOperationState } from "./rowOperationState.js";
import { useEffect } from 'react';
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
      use: options => {
        const result = single.use(params, {
          enabled: options?.enabled
        });
        return {
          data: result.data,
          loadingState: result.loadingState,
          error: result.error,
          hasMore: false,
          loadMore: () => {},
          refresh: async () => {
            await single.fetch(params);
          }
        };
      },
      count: () => read() === undefined ? 0 : 1,
      useCount: () => single.use(params).data === undefined ? 0 : 1,
      invalidate: () => single.invalidate(params),
      issueSequence: () => {
        throw new Error('issueSequence requires an ordered relation');
      }
    };
  }
  const base = {
    read: () => scope.read(params),
    count: () => scope.read(params).length,
    useCount: () => scope.useCount(params),
    invalidate: () => {
      if (query) query.invalidate(params);else scope.invalidate(params);
    },
    issueSequence: field => scope.issueSequence(params, field)
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
const createByIdsRelation = (runtime, ids) => ({
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
    for (const id of ids ?? []) runtime.invalidate({
      id
    });
  },
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
        const input = inputs.get(id);
        if (!input) throw new Error(`${name}: missing poll input for ${id}`);
        return definition.variables(input, {
          tempId: null,
          operationId: ''
        });
      },
      apply: (_id, data) => {
        const row = definition.select(data);
        if (row != null) runtime.insert(row);
      },
      classify: definition.poll.classify,
      intervalMs: definition.poll.intervalMs,
      maxAttempts: definition.poll.maxAttempts
    });
    const idFor = input => String(definition.id(input));
    const retain = id => {
      refs.set(id, (refs.get(id) ?? 0) + 1);
    };
    const release = id => {
      const next = (refs.get(id) ?? 1) - 1;
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
        const id = idFor(input);
        inputs.set(id, input);
        useEffect(() => {
          retain(id);
          const detach = poller.attach(id);
          return () => {
            detach();
            release(id);
          };
        }, [id]);
        return {
          ...poller.usePhase(id),
          refresh: async () => {
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
          if (context.tempId === null) throw new Error(`${name}: insert action requires a temp id`);
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
        selectId: definition.id,
        selectPatch: definition.optimistic.patch
      };
    }
    if (definition.kind === 'destroy' && definition.optimistic === true) {
      return {
        method: 'destroy',
        model: runtime,
        selectId: definition.id
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
    }) : runtime.query(name, {
      document: remote.document,
      vars: remote.variables,
      connection: remote.connection,
      into: runtime.scopes[name],
      requiredScope: remote.required,
      staleTime: remote.staleTime,
      resumeStaleTime: remote.resumeStaleTime,
      emptyStaleTime: remote.emptyStaleTime,
      refetchOnMount: remote.refetchOnMount,
      maxPages: remote.maxPages,
      direction: remote.direction,
      cursorVar: remote.cursorVar
    }) : undefined;
    return [name, query];
  }));
  const relationMethods = Object.create(null);
  for (const name of Object.keys(config.relations ?? {})) {
    Reflect.set(relationMethods, name, params => createNamedRelation(runtime, name, params, compiledRelations[name], config.relations?.[name]?.remote?.type));
  }
  const actions = Object.create(null);
  for (const [name, definition] of Object.entries(config.actions ?? {})) {
    Reflect.set(actions, name, createAction(runtime, `${key}:${name}`, definition));
  }
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
    actions
  };
  const modelBase = Object.assign(base, relationMethods, Object.create(null));
  const associationMethods = new Map();
  let associationsValidated = false;
  const validateAssociations = () => {
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
      const method = id => createAssociationRelation(runtime, property, id);
      associationMethods.set(property, method);
      return method;
    }
  });
  const statics = config.statics?.(model) ?? {};
  for (const name of Object.keys(statics)) {
    if (name in model) throw new Error(`${key}: static ${name} collides with the model surface`);
  }
  return Object.assign(model, statics);
};
//# sourceMappingURL=defineModelFacade.js.map