import type {
  AssociationData,
  AssociationStored,
  DbReadOptions,
  DbWhere,
  FacadeRuntimeModel,
  LoadingState,
  QueryHandle,
  Relation,
  RelationDecl,
  RelationResult,
  ScopeQueryHandle
} from '../types';
import { readModelRelation } from '../core/relations';
import { useRelationLoadMore } from './pagination';

/**
 * Every way a model exposes rows becomes the same `Relation`: a named relation with or without a
 * remote half, an ad-hoc filter, a list of ids, or a declared association. One shape for all of
 * them is what lets a consumer read any of them without knowing which kind it holds.
 */
export const localLoadingState = (hasData: boolean): LoadingState => ({
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

export const createLocalResult = <TData>(data: TData, hasData: boolean, hasMore: boolean, loadMore: () => void): RelationResult<TData> => ({
  data,
  loadingState: localLoadingState(hasData),
  error: null,
  hasMore,
  isFetchingMore: false,
  isPreviousData: false,
  loadMore,
  refresh: async () => {}
});

export const createNamedRelation = <TStored extends { id: string }, TInput>(
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
      refresh: async () => {
        await single.refresh(params);
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
            await single.refresh(params);
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
    refresh: async () => {
      if (query) await query.refresh(params);
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
            await query.refresh(params);
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

export const createWhereRelation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  where: DbWhere<TStored>,
  options?: DbReadOptions<TStored>
): Relation<TStored, TStored[], TInput> => ({
  read: () => runtime.where(where, options),
  fetch: async () => {},
  refresh: async () => {},
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

export const createByIdsRelation = <TStored extends { id: string; updatedAt?: string | null }, TInput>(
  runtime: FacadeRuntimeModel<TStored, TInput>,
  ids: readonly string[] | null | undefined
): Relation<TStored, TStored[], TInput> => ({
  read: () => (ids ?? []).flatMap(id => {
    const row = runtime.find(id);
    return row ? [row] : [];
  }),
  fetch: async () => {},
  refresh: async () => {},
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

export const createAssociationRelation = <
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
    refresh: async () => {},
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
