import type { DocumentNode, OperationDefinitionNode } from 'graphql';
import { CancelledError, QueryObserver } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type {
  ChainMeta,
  ConnectionLike,
  DbGraphQLDocument,
  EnsuredRowQueryHandle,
  EnsuredRowResult,
  ExtractSink,
  ModelDestination,
  PageMeta,
  QueryConfig,
  QueryHandle,
  QueryResult,
  RequestState,
  ScopeDestination,
  ScopeHandle,
  WriteOp
} from '../types';
import { computeLoadingState, computePhase, isFetchedResult } from '../queries/base/loadingState';
import { createCommitEnvelope } from '../core/apply/transaction';
import { buildScopeKey } from '../core/compileDbWhere';
import { compositeKey } from '../core/serialize';
import { registerModelInvalidation } from '../core/invalidationRegistry';
import { isNonArrayRecord, isRecord } from '../utils/normalizeHelpers';
import { getApplyRuntime, getDbQueryClient, getDbRuntimeConfig, getRuntimeGeneration } from './configure';
import { getDbLogger } from '../core/logger';
import { responseDataOrThrow } from '../core/transport';
import { getInternalModelHandle, getInternalScopeHandle, hasInternalScopeHandle } from '../core/internalHandles';
import { refetchActiveFetchReaders, registerActiveFetchReaders } from '../core/fetch/fetchReaderRegistry';
import { isFetchNetworkOnline, subscribeFetchNetwork } from '../core/fetch/networkState';
import { isQueryFresh } from '../core/fetch/queryFreshness';
import { registerKeyedReset, registerReset } from '../core/reset';
import { createKeyedLocalState } from '../core/fetch/keyedLocalState';
/**
 * Create one extract sink only when a row exists; pair with the `{ into, rows }` extract contract.
 *
 * @param into Extract destination.
 * @param row Optional source row.
 * @returns One extract sink, or an empty list.
 */
export const intoIf = (into: ExtractSink['into'], row: unknown): ExtractSink[] => (row == null ? [] : [{ into, rows: [row] }]);
const issuedResetSeqByBucket = new Map<string, number>();
const appliedResetSeqByBucket = new Map<string, number>();
registerReset(() => {
  issuedResetSeqByBucket.clear();
  appliedResetSeqByBucket.clear();
});
const operationKey = (document: DbGraphQLDocument<any, any>, override?: string): string => {
  if (override) return override;
  const operation = (document as DocumentNode).definitions?.find((definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition');
  const name = operation?.name?.value;
  if (!name) throw new Error('defineQuery requires a named operation or an explicit key');
  return name;
};
const nodePairsOf = (value: unknown): Array<{ node: unknown; edgeSource: unknown }> => {
  if (Array.isArray(value)) return value.map(node => ({ node, edgeSource: node }));
  if (!isRecord(value)) return value == null ? [] : [{ node: value, edgeSource: value }];
  const connection = value as ConnectionLike;
  if (connection.nodes) return connection.nodes.map(node => ({ node, edgeSource: node }));
  if (connection.edges) return connection.edges.flatMap(edge => (edge.node == null ? [] : [{ node: edge.node, edgeSource: edge }]));
  return [{ node: value, edgeSource: value }];
};
const isScopeDestination = (into: unknown): into is ScopeHandle<any, any> => isRecord(into) && hasInternalScopeHandle(into);
/** Define a coordinator-owned GraphQL query: react-query drives freshness/single-flight/retry, results land through the store's write seams. */
export const defineQuery = <TResponse, TVars, TScope, TStored>(
  config: QueryConfig<TResponse, TVars, TScope, TStored>
): QueryHandle<TStored, TScope> | EnsuredRowQueryHandle<TStored, TScope> => {
  const keyName = operationKey(config.document, config.key);
  const registeredScopes = new Map<string, TScope>();
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const destinationModelId = (config.into as { modelId?: string }).modelId ?? keyName;
  /** Fields react-query cannot express in our vocabulary: offline pause and next-page distinction. */
  const localState = createKeyedLocalState({ isPaused: false, isFetchingNextPage: false });
  const setLocalState = (key: string, next: Partial<{ isPaused: boolean; isFetchingNextPage: boolean }>): void => localState.set(key, next);
  registerKeyedReset(`query:${keyName}`, () => {
    registeredScopes.clear();
    issuedResetSeqByBucket.clear();
    appliedResetSeqByBucket.clear();
    localState.clear();
  });
  const bucketKeyOf = (scope: TScope): string => compositeKey(keyName, buildScopeKey(scope));
  const queryKeyOf = (key: string): [string, string] => [keyName, key];
  const registerScope = (scope: TScope | null): scope is TScope => {
    if (scope === null) return false;
    if (isScopeDestination(config.into)) getInternalScopeHandle(config.into).key(scope);
    registeredScopes.set(buildScopeKey(scope), scope);
    return true;
  };
  const matchesPartialScope = (scope: TScope, partial: TScope): boolean => {
    if (!isNonArrayRecord(partial)) return Object.is(scope, partial);
    if (!isNonArrayRecord(scope)) return false;
    return Object.entries(partial as Record<string, unknown>).every(([key, value]) => Object.is((scope as Record<string, unknown>)[key], value));
  };
  const pageMetaOf = (connection: ConnectionLike | null): PageMeta => {
    if (!connection) return { endCursor: null, hasNextPage: false, count: 0 };
    const info = connection.pageInfo ?? {};
    const backward = config.direction === 'backward';
    return {
      endCursor: config.getCursor ? config.getCursor(connection) : backward ? (info.startCursor ?? null) : (info.endCursor ?? null),
      hasNextPage: backward ? (info.hasPreviousPage ?? false) : (info.hasNextPage ?? false),
      count: connection.nodes?.length ?? connection.edges?.length ?? 0
    };
  };
  const applyResponse = (scope: TScope, data: TResponse, resetOrder: boolean, resurrectDestroyed: boolean): { meta: PageMeta; ids: string[] } => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : (data as unknown);
    const pairs = nodePairsOf(config.map ? config.map(selected) : selected);
    const nodes = pairs.map(pair => pair.node);
    const ops: WriteOp[] = [];
    const rows = isScopeDestination(config.into) ? pairs.map(pair => ({ row: pair.node as TStored & { id: string }, edge: config.edge?.(pair.edgeSource) })) : [];
    if (isScopeDestination(config.into)) ops.push(...getInternalScopeHandle(config.into).planApply(scope, rows, coverage, { resetOrder }));
    else ops.push(...getInternalModelHandle(config.into).planRows(nodes as TStored[], resurrectDestroyed ? { origin: 'event' as const } : undefined));
    for (const sink of config.extract?.({ data, nodes }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
    if (ops.length > 0) getApplyRuntime().commit(createCommitEnvelope(ops));
    const committedRows = isScopeDestination(config.into) ? rows.map(entry => entry.row) : nodes;
    const ids = committedRows.flatMap(row => (isRecord(row) && row.id != null ? [compositeKey(destinationModelId, String(row.id))] : []));
    return { meta: pageMetaOf(config.page ? config.page(data) : null), ids };
  };
  const execute = async (scope: TScope, key: string, resurrectDestroyed: boolean, context: { cursor: string | null; isCurrent: () => boolean }): Promise<ChainMeta | null> => {
    const cursorVar = config.cursorVar ?? (config.direction === 'backward' ? 'before' : 'after');
    const variables = {
      ...((config.vars?.(scope) ?? {}) as Record<string, unknown>),
      ...(context.cursor != null ? { [cursorVar]: config.mapCursor ? config.mapCursor(context.cursor) : context.cursor } : {})
    };
    const scopeKey = buildScopeKey(scope);
    const guardKey = isScopeDestination(config.into) ? compositeKey(destinationModelId, getInternalScopeHandle(config.into).key(scope)) : compositeKey(keyName, scopeKey);
    const reset = context.cursor === null;
    const issued = reset ? (issuedResetSeqByBucket.get(guardKey) ?? 0) + 1 : (issuedResetSeqByBucket.get(guardKey) ?? 0);
    if (reset) issuedResetSeqByBucket.set(guardKey, issued);
    let data: TResponse;
    try {
      data = responseDataOrThrow(await getDbRuntimeConfig().transport.query({ query: config.document, variables: variables as TVars }));
    } catch (error) {
      const reported = error instanceof Error ? error : new Error(String(error));
      try {
        getDbRuntimeConfig().defaults.onSyncError?.(reported, { source: 'query', model: destinationModelId, key: keyName });
      } catch (observerError) {
        getDbLogger().error('defineQuery onSyncError failed', { error: observerError });
      }
      throw error;
    }
    if (!context.isCurrent()) return null;
    const applied = appliedResetSeqByBucket.get(guardKey) ?? 0;
    if ((reset && issued < applied) || (!reset && issued < (issuedResetSeqByBucket.get(guardKey) ?? 0))) return null;
    if (reset) appliedResetSeqByBucket.set(guardKey, issued);
    const result = applyResponse(scope, data, reset, resurrectDestroyed);
    const previousPages = (getDbQueryClient().getQueryData(queryKeyOf(key)) as ChainMeta | undefined)?.pages ?? 0;
    const pages = config.page ? (reset ? 1 : previousPages + 1) : 1;
    /** maxPages is a hard ceiling: once reached, the chain reports exhaustion and fetchNextPage stops issuing requests. */
    const hasNextPage = result.meta.hasNextPage && (config.maxPages === undefined || pages < config.maxPages);
    return {
      lastCount: result.meta.count,
      cursor: config.page && hasNextPage ? result.meta.endCursor : null,
      pages,
      hasNextPage,
      ids: result.ids
    };
  };
  const staleTimeOf = (key: string): number => {
    const meta = getDbQueryClient().getQueryData(queryKeyOf(key)) as ChainMeta | undefined;
    const defaults = getDbRuntimeConfig().defaults;
    return meta?.lastCount === 0 && (config.emptyStaleTime ?? defaults.emptyStaleTime) != null
      ? (config.emptyStaleTime ?? defaults.emptyStaleTime)!
      : (config.staleTime ?? defaults.staleTime ?? 0);
  };
  const run = async (scope: TScope, options: { restart: boolean; resurrectDestroyed?: boolean; nextPage?: boolean; propagateFailure?: boolean }): Promise<void> => {
    if (config.enabled && !config.enabled(scope)) return;
    const key = bucketKeyOf(scope);
    const client = getDbQueryClient();
    const queryKey = queryKeyOf(key);
    if (!isFetchNetworkOnline()) {
      setLocalState(key, { isPaused: true });
      return;
    }
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({ queryKey });
    setLocalState(key, { isPaused: false, isFetchingNextPage: options.nextPage === true });
    const generation = getRuntimeGeneration();
    try {
      await client.fetchQuery<ChainMeta | null>({
        queryKey,
        queryFn: async () => {
          const chainCursor = options.restart ? null : ((client.getQueryData(queryKey) as ChainMeta | undefined)?.cursor ?? null);
          const cursor = options.nextPage ? chainCursor : null;
          const meta = await execute(scope, key, options.resurrectDestroyed === true, { cursor, isCurrent: () => getRuntimeGeneration() === generation });
          if (meta === null) return (client.getQueryData(queryKey) as ChainMeta | undefined) ?? { lastCount: 0, cursor: null, pages: 0, hasNextPage: false, ids: [] };
          return meta;
        },
        staleTime: options.restart || options.nextPage ? 0 : staleTimeOf(key)
      });
    } catch (error) {
      // A newer restart cancelled this fetch; the superseding run now owns key state and outcome.
      if (error instanceof CancelledError) return;
      if (!isFetchNetworkOnline()) {
        setLocalState(key, { isPaused: true, isFetchingNextPage: false });
        return;
      }
      setLocalState(key, { isFetchingNextPage: false });
      if (options.propagateFailure) throw error instanceof Error ? error : new Error(String(error));
      return;
    }
    setLocalState(key, { isPaused: false, isFetchingNextPage: false });
  };
  const fetch = async (scope: TScope | null): Promise<void> => {
    if (!registerScope(scope)) return;
    await run(scope, { restart: true, propagateFailure: true });
  };
  const invalidate = (scope?: TScope): void => {
    const client = getDbQueryClient();
    const invalidateScope = (registered: TScope) => {
      const queryKey = queryKeyOf(bucketKeyOf(registered));
      // Invalidation is lazy: freshness drops for everyone, but only mounted readers refetch now.
      void client.invalidateQueries({ queryKey, refetchType: 'none' }).then(() => {
        refetchActiveFetchReaders(queryKey);
      });
    };
    if (scope === undefined) {
      for (const registered of registeredScopes.values()) invalidateScope(registered);
      return;
    }
    registerScope(scope);
    for (const registered of registeredScopes.values()) if (matchesPartialScope(registered, scope)) invalidateScope(registered);
  };
  if (destinationModelId) registerModelInvalidation(destinationModelId, keyName, scope => invalidate(scope as TScope | undefined));
  const useObservedState = (key: string): RequestState => {
    const client = getDbQueryClient();
    const generation = getRuntimeGeneration();
    const observerRef = useRef<{ key: string; generation: number; observer: QueryObserver<ChainMeta | null> } | null>(null);
    if (observerRef.current === null || observerRef.current.key !== key || observerRef.current.generation !== generation) {
      observerRef.current = { key, generation, observer: new QueryObserver<ChainMeta | null>(client, { queryKey: queryKeyOf(key), enabled: false, staleTime: Infinity }) };
    }
    const observer = observerRef.current.observer;
    const subscribe = useCallback(
      (onStoreChange: () => void) => {
        const unsubscribeObserver = observer.subscribe(onStoreChange);
        const unsubscribeLocal = localState.subscribe(key, onStoreChange);
        return () => {
          unsubscribeObserver();
          unsubscribeLocal();
        };
      },
      [key, observer]
    );
    const getSnapshot = useCallback(
      () =>
        `${observer.getCurrentResult().fetchStatus}:${observer.getCurrentResult().status}:${observer.getCurrentResult().failureCount}:${observer.getCurrentResult().dataUpdatedAt}:${localState.version(key)}`,
      [key, observer]
    );
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const result = observer.getCurrentResult();
    const local = localState.get(key);
    const meta = (result.data ?? undefined) as ChainMeta | undefined;
    return {
      isFetching: result.fetchStatus === 'fetching',
      isFetchingNextPage: local.isFetchingNextPage && result.fetchStatus === 'fetching',
      isFetched: isFetchedResult(result),
      isPaused: local.isPaused,
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null,
      hasNextPage: meta?.hasNextPage ?? false
    };
  };
  const useReader = (scope: TScope | null, enabled: boolean, resurrectDestroyed: boolean, forceAbsentRefetch: boolean): RequestState => {
    const key = scope === null ? compositeKey(keyName, 'inactive') : bucketKeyOf(scope);
    const state = useObservedState(key);
    const mountedKey = useRef<string | null>(null);
    const forcedRefetch = useRef(false);
    if (mountedKey.current !== key) forcedRefetch.current = false;
    useEffect(() => {
      if (scope === null || !enabled) return;
      const client = getDbQueryClient();
      const queryKey = queryKeyOf(key);
      const resumeWindow = (): number | null => (config.resumeStaleTime === undefined ? getDbRuntimeConfig().defaults.resumeStaleTime : config.resumeStaleTime);
      const markResumeStale = (): boolean => {
        const window = resumeWindow();
        if (window === null || isQueryFresh(client, queryKey, window)) return false;
        void client.invalidateQueries({ queryKey, refetchType: 'none' });
        return true;
      };
      const release = registerActiveFetchReaders({
        queryKey,
        markResumeStale,
        refetch: () => run(scope, { restart: false, resurrectDestroyed }).catch(() => {})
      });
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const isFresh = isQueryFresh(client, queryKey, staleTimeOf(key));
      const canRefetch = !firstMount || !state.isFetched || (config.refetchOnMount ?? getDbRuntimeConfig().defaults.refetchOnMount) !== false;
      const shouldFetch = firstMount && canRefetch;
      if (shouldFetch && !isFresh && !state.isFetching) {
        void run(scope, { restart: false, resurrectDestroyed }).catch(() => {});
      }
      if (forceAbsentRefetch && state.isFetched && !state.isFetching && !forcedRefetch.current) {
        forcedRefetch.current = true;
        void run(scope, { restart: true, resurrectDestroyed }).catch(() => {});
      }
      const unsubscribeOnline = subscribeFetchNetwork(() => {
        if (!isFetchNetworkOnline()) return;
        if (!isQueryFresh(client, queryKey, staleTimeOf(key))) void run(scope, { restart: false, resurrectDestroyed }).catch(() => {});
      });
      return () => {
        unsubscribeOnline();
        release();
      };
    }, [enabled, forceAbsentRefetch, key, resurrectDestroyed, scope, state.isFetched, state.isFetching]);
    return state;
  };
  const buildResult = (rows: TStored[] | undefined, enabled: boolean, state: RequestState, scope: TScope | null): QueryResult<TStored> => {
    const hasData = Array.isArray(rows) ? rows.length > 0 : rows !== undefined;
    const phaseInput = {
      isInactive: !enabled && !hasData,
      isFetching: state.isFetching,
      committedRowsDied: false,
      isPaused: state.isPaused,
      retryAttempt: state.retryAttempt,
      hasData,
      isRefreshing: state.isFetching && hasData && !state.isFetchingNextPage,
      isFetchingNextPage: state.isFetchingNextPage,
      isError: state.error !== null,
      hasFetchedData: state.isFetched
    };
    return {
      data: rows,
      loadingState: computeLoadingState(computePhase(phaseInput), phaseInput),
      error: state.error,
      hasNextPage: config.page ? state.hasNextPage : false,
      isFetchingNextPage: config.page ? state.isFetchingNextPage : false,
      fetchNextPage: () => {
        if (scope !== null && config.page && state.hasNextPage && !state.isFetching) void run(scope, { restart: false, nextPage: true }).catch(() => {});
      },
      refetch: async () => {
        if (scope !== null) await run(scope, { restart: true });
      }
    };
  };
  const useDestinationRows: (scope: TScope | null) => TStored[] | undefined = isScopeDestination(config.into)
    ? scope => (config.into as ScopeDestination<TStored, TScope>).use(scope) as TStored[]
    : () => undefined;
  const use = (scope: TScope | null, options?: { enabled?: boolean }): QueryResult<TStored> => {
    registerScope(scope);
    const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const state = useReader(scope, enabled, false, false);
    return buildResult(useDestinationRows(scope), enabled, state, scope);
  };
  const handle: QueryHandle<TStored, TScope> = { use, fetch, invalidate };
  if (isScopeDestination(config.into)) return handle;
  const destination = config.into as ModelDestination<TStored>;
  const useRowEnsured = (scope: TScope, rowId: string | null | undefined, readOpts?: { renderKeys?: readonly (keyof TStored & string)[] }): EnsuredRowResult<TStored> => {
    registerScope(scope);
    const row = destination.use.find(rowId, readOpts);
    const enabled = row === undefined && rowId != null && (config.enabled?.(scope) ?? true);
    const state = useReader(scope, enabled, true, enabled);
    const hasData = row !== undefined;
    const phaseInput = {
      isInactive: !enabled && !hasData,
      isFetching: state.isFetching,
      committedRowsDied: false,
      isPaused: state.isPaused,
      retryAttempt: state.retryAttempt,
      hasData,
      isRefreshing: false,
      isFetchingNextPage: false,
      isError: state.error !== null,
      hasFetchedData: state.isFetched
    };
    return {
      row,
      loadingState: computeLoadingState(computePhase(phaseInput), phaseInput),
      error: state.error,
      refetch: async () => await run(scope, { restart: true, resurrectDestroyed: true })
    };
  };
  return { ...handle, useRowEnsured };
};
