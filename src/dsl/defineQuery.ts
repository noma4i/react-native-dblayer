import type { DocumentNode, OperationDefinitionNode } from 'graphql';
import { CancelledError } from '@tanstack/react-query';
import { union } from 'es-toolkit';
import { useEffect, useRef } from 'react';
import type {
  ChainMeta,
  ConnectionLike,
  DbGraphQLDocument,
  EnsuredRowQueryHandle,
  EnsuredRowResult,
  ExtractSink,
  MaterializedChain,
  ModelDestination,
  PageMeta,
  QueryConfig,
  QueryHandle,
  QueryResult,
  RequestState,
  ScopeDestination,
  ScopeHandle,
  ScopeWindowResult,
  WriteOp
} from '../types';
import { bridgeWindowPagination, useLoadMore } from './pagination';
import { computeLoadingState, computePhase, isFetchedResult } from '../queries/base/loadingState';
import { useObservedQuery } from '../core/fetch/useObservedQuery';
import { createCommitEnvelope } from '../core/apply/commitEnvelope';
import { buildScopeKey } from '../core/compileDbWhere';
import { compositeKey, parseCompositeKey, stableSerialize } from '../core/serialize';
import { registerModelInvalidation } from '../core/invalidationRegistry';
import { isNonArrayRecord, isRecord } from '../utils/normalizeHelpers';
import { getApplyRuntime, getDbQueryClient, getDbRuntimeConfig } from './configure';
import { responseDataOrThrow } from '../core/transport';
import { getInternalModelHandle, getInternalScopeHandle, hasInternalScopeHandle } from '../core/internalHandles';
import { refetchActiveFetchReaders, registerActiveFetchReaders, registerMaterializationReconciler } from '../core/fetch/fetchReaderRegistry';
import { createOfflineFetchError, isFetchNetworkOnline } from '../core/fetch/networkState';
import { isQueryFresh, persistenceWindowOf, resolveStaleTime } from '../core/fetch/queryFreshness';
import { registerKeyedReset, registerReset } from '../core/reset';
import { createKeyedLocalState } from '../core/fetch/keyedLocalState';
import { createGenerationFence } from '../utils/runtimeGeneration';
import { fromNodes } from '../queries/base/connection';
import { reportSyncError } from '../core/syncError';
import { invalidatePersistedQuery } from '../core/queryPersistence';
import { persistBucket, restorePersistedBucket } from '../core/fetch/persistedBucket';
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
const nodesOf = (value: unknown, connectionExpected: boolean): unknown[] => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (!isRecord(value)) throw new Error('defineQuery select/page must return rows, a row, or a connection');
  const connection = value as ConnectionLike;
  if (connection.nodes) return [...connection.nodes];
  if (connection.edges) return connection.edges.flatMap(edge => (edge?.node == null ? [] : [edge.node]));
  if (connectionExpected) return [];
  return [value];
};
const isScopeDestination = (into: unknown): into is ScopeHandle<any, any> => isRecord(into) && hasInternalScopeHandle(into);
const isChainMeta = (value: unknown): value is ChainMeta =>
  isRecord(value) &&
  (value.cursor === null || typeof value.cursor === 'string') &&
  typeof value.pages === 'number' &&
  Number.isSafeInteger(value.pages) &&
  value.pages >= 0 &&
  typeof value.hasNextPage === 'boolean' &&
  Array.isArray(value.ids) &&
  value.ids.every(id => typeof id === 'string') &&
  (value.resultKind === 'one' || value.resultKind === 'many');
const isEmptyChain = (value: ChainMeta): boolean => value.ids.length === 0;
/** Largest delay a 32-bit timer holds; anything above it fires on the next tick instead of later. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Fail fast at define time, then rewrite the `connection` shorthand into the one `page` seam - dense nodes, pageInfo passthrough. */
const normalizeQueryConfig = <TResponse, TVars, TScope, TStored>(config: QueryConfig<TResponse, TVars, TScope, TStored>): QueryConfig<TResponse, TVars, TScope, TStored> => {
  const readConnection = config.connection;
  if (!readConnection) return config;
  if (config.page || config.select) throw new Error('defineQuery: connection is mutually exclusive with page/select');
  return {
    ...config,
    connection: undefined,
    page: data => {
      const value = readConnection(data);
      return { nodes: fromNodes(value as { nodes?: ReadonlyArray<unknown | null> } | null | undefined), pageInfo: value?.pageInfo };
    }
  };
};
/** Define a coordinator-owned GraphQL query: react-query drives freshness/single-flight/retry, results land through the store's write seams. */
export const defineQuery = <TResponse, TVars, TScope, TStored>(
  rawConfig: QueryConfig<TResponse, TVars, TScope, TStored>
): QueryHandle<TStored, TScope> | EnsuredRowQueryHandle<TStored, TScope> => {
  const config = normalizeQueryConfig(rawConfig);
  const keyName = operationKey(config.document, config.key);
  const registeredScopes = new Map<string, TScope>();
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const destinationModelId = config.into.modelId;
  const destinationScope = isScopeDestination(config.into) ? getInternalScopeHandle(config.into) : null;
  const persistenceVersion = config.persistenceVersion ?? 1;
  const persistenceDeclaration = {
    family: `query:${keyName}`,
    persistenceVersion,
    fingerprint: stableSerialize({
      kind: 'query',
      key: keyName,
      persistenceVersion,
      destinationModelId,
      destinationKind: destinationScope ? 'scope' : 'model',
      coverage,
      paged: config.page !== undefined,
      direction: config.direction ?? 'forward',
      cursorVar: config.cursorVar ?? null,
      maxPages: config.maxPages ?? null
    })
  };
  /** Fields react-query cannot express in our vocabulary: offline pause, next-page distinction, and the per-bucket invalidate sequence. */
  const localState = createKeyedLocalState({ isPaused: false, isFetchingNextPage: false, invalidateSeq: 0 });
  const setLocalState = (key: string, next: Partial<{ isPaused: boolean; isFetchingNextPage: boolean; invalidateSeq: number }>): void => localState.set(key, next);
  registerKeyedReset(`query:${keyName}`, () => {
    registeredScopes.clear();
    issuedResetSeqByBucket.clear();
    appliedResetSeqByBucket.clear();
    localState.clear();
  });
  const bucketKeyOf = (scope: TScope): string => compositeKey(keyName, buildScopeKey(scope));
  const queryKeyOf = (key: string): [string, string] => [keyName, key];
  const normalizeScope = (scope: TScope): TScope => (destinationScope ? (destinationScope.normalize(scope) as TScope) : scope);
  const registerScope = (rawScope: TScope | null): TScope | null => {
    if (rawScope === null) return null;
    const scope = normalizeScope(rawScope);
    destinationScope?.key(scope);
    registeredScopes.set(bucketKeyOf(scope), scope);
    return scope;
  };
  const matchesPartialScope = (scope: TScope, partial: TScope): boolean => {
    if (!isNonArrayRecord(partial)) return Object.is(scope, partial);
    if (!isNonArrayRecord(scope)) return false;
    return Object.entries(partial as Record<string, unknown>).every(([key, value]) => Object.is((scope as Record<string, unknown>)[key], value));
  };
  const persistenceWindow = (empty: boolean): number | null => persistenceWindowOf(empty, config.staleTime, config.emptyStaleTime, getDbRuntimeConfig().defaults);
  const validateDestination = (scope: TScope, meta: ChainMeta): void => {
    // An empty chain materializes nothing, so there is no destination to require: an empty result
    // never persists a scope snapshot, and demanding one would make every empty record stale.
    if (meta.ids.length === 0) return;
    const parsedIds = meta.ids.map(id => parseCompositeKey(id));
    if (parsedIds.some(parts => parts?.length !== 2 || parts[0] !== destinationModelId)) {
      throw new Error('react-native-dblayer: persisted query row identity does not match its destination');
    }
    if (destinationScope) {
      if (!destinationScope.isResolved(scope)) {
        throw new Error('react-native-dblayer: persisted query scope destination is missing');
      }
      const rowIds = destinationScope.readRows(scope).map(row => destinationScope.normalizeRowId(row));
      if (parsedIds.some(parts => !rowIds.includes(parts![1]!))) {
        throw new Error('react-native-dblayer: persisted query scope row is missing');
      }
      return;
    }
    const destination = config.into as ModelDestination<TStored>;
    if (parsedIds.some(parts => destination.find(parts![1]!) === undefined)) {
      throw new Error('react-native-dblayer: persisted query model row is missing');
    }
  };
  /**
   * Composite ids this chain still materializes: scope membership for a scope destination, row
   * presence otherwise. The registry calls it only after reading landed non-empty chain ids for
   * this key, so the model branch reads the same cached meta unconditionally.
   */
  const materializedIds = (scope: TScope): ReadonlySet<string> => {
    if (destinationScope) {
      if (!destinationScope.isResolved(scope)) return new Set();
      return new Set(destinationScope.readRows(scope).map(row => compositeKey(destinationModelId, destinationScope.normalizeRowId(row))));
    }
    const destination = config.into as ModelDestination<TStored>;
    const meta = getDbQueryClient().getQueryData(queryKeyOf(bucketKeyOf(scope))) as ChainMeta;
    return new Set(meta.ids.filter(id => destination.find(parseCompositeKey(id)![1]!) !== undefined));
  };
  /** Every registered chain with the destination it depends on; the registry owns selection and pruning. */
  const materializationChains = function* (): Iterable<MaterializedChain> {
    for (const scope of registeredScopes.values()) {
      yield {
        queryKey: queryKeyOf(bucketKeyOf(scope)),
        scopeKey: destinationScope ? destinationScope.key(scope) : null,
        materialized: () => materializedIds(scope)
      };
    }
  };
  registerMaterializationReconciler({ modelId: destinationModelId, chains: materializationChains });
  const restore = (scope: TScope): ChainMeta | undefined => {
    const identity = bucketKeyOf(scope);
    const cached = getDbQueryClient().getQueryData(queryKeyOf(identity)) as ChainMeta | undefined;
    if (cached !== undefined) return cached;
    return restorePersistedBucket<ChainMeta, ChainMeta, TScope>({
      declaration: persistenceDeclaration,
      identity,
      queryKey: queryKeyOf(identity),
      validate: candidate => {
        const restoredScope = normalizeScope(candidate.scope as TScope);
        if (bucketKeyOf(restoredScope) !== identity || !isChainMeta(candidate.payload)) {
          throw new Error('react-native-dblayer: persisted query identity or metadata is invalid');
        }
        validateDestination(restoredScope, candidate.payload);
        return { payload: candidate.payload, scope: restoredScope };
      },
      cache: meta => meta,
      window: persistenceWindow
    });
  };
  const persist = (scope: TScope, meta: ChainMeta): void => {
    const identity = bucketKeyOf(scope);
    persistBucket<ChainMeta, TScope>({
      declaration: persistenceDeclaration,
      identity,
      queryKey: queryKeyOf(identity),
      scope,
      payload: meta,
      empty: isEmptyChain(meta),
      window: persistenceWindow
    });
  };
  const pageMetaOf = (connection: ConnectionLike): PageMeta => {
    const info = connection.pageInfo ?? {};
    const backward = config.direction === 'backward';
    return {
      endCursor: config.getCursor ? config.getCursor(connection) : backward ? (info.startCursor ?? null) : (info.endCursor ?? null),
      hasNextPage: backward ? (info.hasPreviousPage ?? false) : (info.hasNextPage ?? false)
    };
  };
  const applyResponse = (
    scope: TScope,
    data: TResponse,
    resetOrder: boolean,
    resurrectDestroyed: boolean
  ): { meta: PageMeta; ids: string[]; resultKind: ChainMeta['resultKind'] } => {
    const selected = config.page ? config.page(data) : config.select ? config.select(data) : (data as unknown);
    const nodes = nodesOf(selected, config.page !== undefined);
    const ops: WriteOp[] = [];
    const rows = isScopeDestination(config.into) ? nodes.map(node => ({ row: node as TStored & { id: string } })) : [];
    if (isScopeDestination(config.into)) ops.push(...getInternalScopeHandle(config.into).planApply(scope, rows, coverage, { resetOrder }));
    else ops.push(...getInternalModelHandle(config.into).planRows(nodes as TStored[], resurrectDestroyed ? { origin: 'event' as const } : undefined));
    for (const sink of config.extract?.({ data, nodes }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
    if (ops.length > 0) getApplyRuntime().commit(createCommitEnvelope(ops));
    const committedRows = isScopeDestination(config.into) ? rows.map(entry => entry.row) : nodes;
    const normalizeRowId = isScopeDestination(config.into)
      ? (row: unknown) => getInternalScopeHandle(config.into).normalizeRowId(row)
      : (row: unknown) => getInternalModelHandle(config.into).normalizeRowId(row);
    const ids = committedRows.map(row => compositeKey(destinationModelId, normalizeRowId(row)));
    const meta = config.page ? pageMetaOf(config.page(data)) : { endCursor: null, hasNextPage: false };
    return { meta, ids, resultKind: config.page || Array.isArray(selected) ? 'many' : 'one' };
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
    const issued = reset ? (issuedResetSeqByBucket.get(guardKey) ?? 0) + 1 : issuedResetSeqByBucket.get(guardKey)!;
    if (reset) issuedResetSeqByBucket.set(guardKey, issued);
    let data: TResponse;
    try {
      data = responseDataOrThrow(await getDbRuntimeConfig().transport.query({ query: config.document, variables: variables as TVars }));
    } catch (error) {
      if (!context.isCurrent()) throw error;
      reportSyncError(error, { source: 'query', model: destinationModelId, key: keyName }, 'defineQuery');
      throw error;
    }
    if (!context.isCurrent()) return null;
    const applied = appliedResetSeqByBucket.get(guardKey) ?? 0;
    if ((reset && issued < applied) || (!reset && issued < issuedResetSeqByBucket.get(guardKey)!)) return null;
    if (reset) appliedResetSeqByBucket.set(guardKey, issued);
    const result = applyResponse(scope, data, reset, resurrectDestroyed);
    const previous = getDbQueryClient().getQueryData(queryKeyOf(key)) as ChainMeta | undefined;
    const previousPages = previous?.pages ?? 0;
    const pages = config.page ? (reset ? 1 : previousPages + 1) : 1;
    /** maxPages is a hard ceiling: once reached, the chain reports exhaustion and fetchNextPage stops issuing requests. */
    const hasNextPage = result.meta.hasNextPage && (config.maxPages === undefined || pages < config.maxPages);
    return {
      cursor: config.page && hasNextPage ? result.meta.endCursor : null,
      pages,
      hasNextPage,
      ids: reset ? result.ids : union(previous!.ids, result.ids),
      resultKind: result.resultKind
    };
  };
  /**
   * The declared window doubles as the refresh cadence while a reader watches. A window only
   * consulted when a reader mounts cannot repair a feed whose live channel died under a screen the
   * user never left, which is the case the window is declared for. `Infinity` and `0` opt out: one
   * declares data that never ages, the other data whose every read is already a fetch.
   */
  const refreshIntervalOf = (key: string): number | false => {
    const window = staleTimeOf(key);
    // A window past the platform timer ceiling is not a long schedule - the timer silently collapses
    // to the next tick and the screen starts polling the transport. Such a window declares data that
    // does not age, which is the same answer as `Infinity` and `0`: no schedule.
    return window > 0 && window <= MAX_TIMER_DELAY_MS ? window : false;
  };
  const staleTimeOf = (key: string): number => {
    const meta = (getDbQueryClient().getQueryData(queryKeyOf(key)) ?? undefined) as ChainMeta | undefined;
    const defaults = getDbRuntimeConfig().defaults;
    return meta !== undefined && isEmptyChain(meta) && (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime) != null
      ? (resolveStaleTime(config.emptyStaleTime, defaults) ?? defaults.emptyStaleTime)!
      : (resolveStaleTime(config.staleTime, defaults) ?? defaults.staleTime ?? 0);
  };
  const run = async (scope: TScope, options: { restart: boolean; resurrectDestroyed?: boolean; nextPage?: boolean; propagateFailure?: boolean }): Promise<void> => {
    resolveStaleTime(config.staleTime, getDbRuntimeConfig().defaults);
    resolveStaleTime(config.emptyStaleTime, getDbRuntimeConfig().defaults);
    if (config.enabled && !config.enabled(scope)) return;
    const key = bucketKeyOf(scope);
    const client = getDbQueryClient();
    const queryKey = queryKeyOf(key);
    const restored = restore(scope);
    if (!isFetchNetworkOnline()) {
      setLocalState(key, { isPaused: true });
      if (restored === undefined && options.propagateFailure) throw createOfflineFetchError();
      return;
    }
    // Cancellation is synchronous; awaiting it would open a microtask window where a
    // concurrent restart dedupes into the fetch this one is about to supersede.
    if (options.restart) void client.cancelQueries({ queryKey });
    setLocalState(key, { isPaused: false, isFetchingNextPage: options.nextPage === true });
    const generationFence = createGenerationFence();
    const invalidateSeqAtStart = localState.get(key).invalidateSeq;
    try {
      const meta = await client.fetchQuery<ChainMeta | null>({
        queryKey,
        queryFn: async () => {
          const chainCursor = options.restart ? null : ((client.getQueryData(queryKey) as ChainMeta | undefined)?.cursor ?? null);
          const cursor = options.nextPage ? chainCursor : null;
          const meta = await execute(scope, key, options.resurrectDestroyed === true, { cursor, isCurrent: generationFence.isCurrent });
          if (meta === null) {
            return (
              (client.getQueryData(queryKey) as ChainMeta | undefined) ?? {
                cursor: null,
                pages: 0,
                hasNextPage: false,
                ids: [],
                resultKind: 'one'
              }
            );
          }
          return meta;
        },
        staleTime: options.restart || options.nextPage ? 0 : staleTimeOf(key)
      });
      if (meta !== null) persist(scope, meta);
      if (localState.get(key).invalidateSeq !== invalidateSeqAtStart) {
        // An invalidate landed while this fetch was in flight. The response predates it, so it
        // cannot satisfy it: restore the invalidated mark the landing cleared and run once more.
        await client.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
        await run(scope, { restart: false, resurrectDestroyed: options.resurrectDestroyed, propagateFailure: options.propagateFailure });
      }
    } catch (error) {
      if (!generationFence.isCurrent()) {
        if (options.propagateFailure) throw new Error('react-native-dblayer: defineQuery response dropped - runtime was reset before it resolved');
        return;
      }
      // A newer restart cancelled this fetch; the superseding run now owns key state and outcome.
      if (error instanceof CancelledError) return;
      if (!isFetchNetworkOnline()) {
        setLocalState(key, { isPaused: true, isFetchingNextPage: false });
        const cached = client.getQueryData(queryKey) as ChainMeta | undefined;
        if (cached === undefined && options.propagateFailure) throw createOfflineFetchError();
        return;
      }
      setLocalState(key, { isFetchingNextPage: false });
      if (!options.restart && client.getQueryData(queryKey) !== undefined) return;
      if (options.propagateFailure) throw error instanceof Error ? error : new Error(String(error));
      return;
    }
    if (!generationFence.isCurrent()) return;
    setLocalState(key, { isPaused: false, isFetchingNextPage: false });
  };
  /** `requiredScope` gate: a nullish declared key means "this scope is not addressable yet" - identical to `scope: null`. */
  const scopeGate = (scope: TScope | null): TScope | null =>
    scope !== null && config.requiredScope?.some(key => (scope as Record<string, unknown>)[key] == null) ? null : scope;
  const fetch = async (rawScope: TScope | null): Promise<void> => {
    const scope = registerScope(scopeGate(rawScope));
    if (scope === null) return;
    await run(scope, { restart: false, propagateFailure: true });
  };
  const refresh = async (rawScope: TScope | null): Promise<void> => {
    const scope = registerScope(scopeGate(rawScope));
    if (scope === null) return;
    await run(scope, { restart: true, propagateFailure: true });
  };
  const invalidateRegisteredScope = (registered: TScope): void => {
    const client = getDbQueryClient();
    const key = bucketKeyOf(registered);
    const queryKey = queryKeyOf(key);
    // The sequence lets an in-flight run see that this invalidate outranks its response.
    setLocalState(key, { invalidateSeq: localState.get(key).invalidateSeq + 1 });
    // Invalidation is lazy: freshness drops for everyone, but only mounted readers refetch now.
    void client.invalidateQueries({ queryKey, refetchType: 'none' }).then(() => {
      refetchActiveFetchReaders(queryKey);
    });
  };
  const invalidateMatching = (partial: TScope): void => {
    invalidatePersistedQuery(persistenceDeclaration, record => {
      try {
        const scope = normalizeScope(record.scope as TScope);
        destinationScope?.key(scope);
        return matchesPartialScope(scope, partial);
      } catch {
        return false;
      }
    });
    for (const registered of registeredScopes.values()) {
      if (!matchesPartialScope(registered, partial)) continue;
      invalidateRegisteredScope(registered);
    }
  };
  const invalidateAll = (): void => {
    invalidatePersistedQuery(persistenceDeclaration, () => true);
    for (const registered of registeredScopes.values()) invalidateRegisteredScope(registered);
  };
  const invalidate = (scope?: TScope): void => {
    if (scope === undefined) {
      invalidateAll();
      return;
    }
    const normalized = registerScope(scope);
    if (normalized !== null) invalidateMatching(normalized);
  };
  if (destinationModelId) {
    registerModelInvalidation(destinationModelId, keyName, scope => {
      if (scope === undefined) {
        invalidateAll();
        return;
      }
      if (destinationScope && !destinationScope.isComplete(scope)) return;
      invalidateMatching(normalizeScope(scope as TScope));
    });
  }
  const useObservedState = (key: string, scope: TScope | null, enabled: boolean, resurrectDestroyed: boolean): RequestState => {
    const client = getDbQueryClient();
    // One entry point for every automatic fetch of this bucket: the declared window is the
    // observer's real `staleTime`, so first load, mounting on stale data, reconnecting and the
    // interval are all decided by React Query. `run` stays for what a caller asks for by name -
    // `fetch`, `refresh`, next page - where the caller owns the outcome and the error.
    const observerOptions = {
      queryKey: queryKeyOf(key),
      enabled: enabled && scope !== null,
      staleTime: staleTimeOf(key),
      // The scheduled path pauses offline and resumes itself on reconnect, which is what a reader
      // watching a screen needs. The imperative path keeps the runtime default: a caller awaiting
      // `fetch()` must get an offline error rather than a promise that waits for the network.
      networkMode: 'online' as const,
      refetchOnMount: config.refetchOnMount ?? getDbRuntimeConfig().defaults.refetchOnMount ?? true,
      refetchOnReconnect: true,
      refetchIntervalInBackground: false,
      refetchInterval: () => refreshIntervalOf(key),
      queryFn: async (): Promise<ChainMeta | null> => {
        const current = () => (client.getQueryData(queryKeyOf(key)) as ChainMeta | undefined) ?? null;
        if (scope === null) return current();
        const fence = createGenerationFence();
        let issuedAt = localState.get(key).invalidateSeq;
        let meta = await execute(scope, key, resurrectDestroyed, { cursor: null, isCurrent: fence.isCurrent });
        // An invalidate that landed while this fetch was in flight outranks the response: it was
        // issued after the request left, so the answer predates it and cannot satisfy it. Reading
        // again inside this fetch keeps the debt with the fetch that owes it - a follow-up scheduled
        // outside would dedupe straight back into the fetch it is meant to supersede.
        while (fence.isCurrent() && localState.get(key).invalidateSeq !== issuedAt) {
          issuedAt = localState.get(key).invalidateSeq;
          meta = (await execute(scope, key, resurrectDestroyed, { cursor: null, isCurrent: fence.isCurrent })) ?? meta;
        }
        return meta ?? current();
      }
    };
    const result = useObservedQuery<ChainMeta | null>(key, observerOptions, `${observerOptions.enabled}:${String(refreshIntervalOf(key))}`, localState);
    const local = localState.get(key);
    const meta = (result.data ?? undefined) as ChainMeta | undefined;
    return {
      isFetching: result.fetchStatus === 'fetching',
      isFetchingNextPage: local.isFetchingNextPage && result.fetchStatus === 'fetching',
      isFetched: isFetchedResult(result),
      isPaused: local.isPaused || result.fetchStatus === 'paused',
      retryAttempt: result.fetchStatus === 'fetching' ? result.failureCount : 0,
      error: result.error instanceof Error ? result.error : result.error != null ? new Error(String(result.error)) : null,
      hasNextPage: meta?.hasNextPage ?? false,
      ids: meta?.ids ?? [],
      resultKind: meta?.resultKind ?? (config.page ? 'many' : 'one'),
      dataUpdatedAt: result.dataUpdatedAt
    };
  };
  const useReader = (scope: TScope | null, enabled: boolean, resurrectDestroyed: boolean, forceAbsentRefetch: boolean): RequestState => {
    const key = scope === null ? compositeKey(keyName, 'inactive') : bucketKeyOf(scope);
    const state = useObservedState(key, scope, enabled, resurrectDestroyed);
    const mountedKey = useRef<string | null>(null);
    const forcedRefetch = useRef(false);
    if (mountedKey.current !== key) forcedRefetch.current = false;
    // Freshness has to survive a restart whichever path fetched, and the scheduled refresh lands
    // through the observer rather than through `run`. Following the landing timestamp records both.
    useEffect(() => {
      if (scope === null || state.dataUpdatedAt === 0) return;
      const meta = getDbQueryClient().getQueryData(queryKeyOf(key)) as ChainMeta | undefined;
      if (meta !== undefined) persist(scope, meta);
    }, [key, scope, state.dataUpdatedAt]);
    useEffect(() => {
      if (scope === null || !enabled) return;
      const client = getDbQueryClient();
      const queryKey = queryKeyOf(key);
      const resumeWindow = (): number | null => (config.resumeStaleTime === undefined ? getDbRuntimeConfig().defaults.resumeStaleTime : config.resumeStaleTime);
      const markResumeStale = (): boolean => {
        const window = resumeWindow();
        if (window === null || isQueryFresh(client, queryKey, window)) return false;
        setLocalState(key, { invalidateSeq: localState.get(key).invalidateSeq + 1 });
        void client.invalidateQueries({ queryKey, refetchType: 'none' });
        return true;
      };
      const release = registerActiveFetchReaders({
        queryKey,
        markResumeStale,
        refetch: () => run(scope, { restart: false, resurrectDestroyed })
      });
      mountedKey.current = key;
      if (forceAbsentRefetch && state.isFetched && !state.isFetching && !forcedRefetch.current) {
        forcedRefetch.current = true;
        void run(scope, { restart: true, resurrectDestroyed });
      }
      return release;
    }, [enabled, forceAbsentRefetch, key, resurrectDestroyed, scope, state.isFetched, state.isFetching]);
    return state;
  };
  const buildResult = (rows: TStored[] | TStored | undefined, enabled: boolean, state: RequestState, scope: TScope | null): QueryResult<TStored> => {
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
        if (scope !== null && config.page && state.hasNextPage && !state.isFetching) void run(scope, { restart: false, nextPage: true });
      },
      refresh: async () => {
        if (scope !== null) await run(scope, { restart: true });
      }
    };
  };
  const readDestinationRows = (rawScope: TScope | null): TStored[] | TStored | undefined => {
    const gatedScope = scopeGate(rawScope);
    const scope = registerScope(gatedScope);
    if (scope === null) return isScopeDestination(config.into) ? [] : undefined;
    restore(scope);
    if (isScopeDestination(config.into)) return config.into.read(scope);
    const destination = config.into as ModelDestination<TStored>;
    const meta = getDbQueryClient().getQueryData(queryKeyOf(bucketKeyOf(scope))) as ChainMeta | undefined;
    const rows = (meta?.ids ?? []).map(id => destination.find(parseCompositeKey(id)![1]!)!);
    return meta?.resultKind === 'many' ? rows : rows[0];
  };
  const useDestinationRows: (scope: TScope | null, state: RequestState) => TStored[] | TStored | undefined = isScopeDestination(config.into)
    ? scope => (config.into as ScopeDestination<TStored, TScope>).use(scope) as TStored[]
    : (_scope, state) => {
        const destination = config.into as ModelDestination<TStored>;
        const rowIds = state.ids.map(id => parseCompositeKey(id)![1]!);
        const rows = destination.use.byIds(rowIds).rows;
        return state.resultKind === 'many' ? rows : rows[0];
      };
  const use = (rawScope: TScope | null, options?: { enabled?: boolean }): QueryResult<TStored> => {
    const scope = registerScope(scopeGate(rawScope));
    if (scope !== null) restore(scope);
    const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const state = useReader(scope, enabled, false, false);
    return buildResult(useDestinationRows(scope, state), enabled, state, scope);
  };
  const handle: QueryHandle<TStored, TScope> = { read: readDestinationRows, use, fetch, refresh, invalidate };
  if (isScopeDestination(config.into)) {
    const scopeHandle = config.into as ScopeDestination<TStored & { id: string }, TScope> as {
      useWindow: (scope: TScope | null, opts: { pageSize?: number; renderKeys?: readonly string[]; require?: readonly string[]; keepPrevious?: boolean }) => ScopeWindowResult<TStored>;
    };
    const useWindow = (
      rawScope: TScope | null,
      options?: { pageSize?: number; renderKeys?: readonly string[]; require?: readonly string[]; keepPrevious?: boolean; enabled?: boolean; loadMoreDebounceMs?: number }
    ) => {
      const scope = registerScope(scopeGate(rawScope));
      const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
      const state = useReader(scope, enabled, false, false);
      const window = scopeHandle.useWindow(scope, {
        pageSize: options?.pageSize,
        renderKeys: options?.renderKeys,
        require: options?.require,
        keepPrevious: options?.keepPrevious
      });
      const result = buildResult(window.rows as TStored[], enabled, state, scope);
      const bridge = bridgeWindowPagination(window, result);
      const loadMore = useLoadMore(bridge, { debounceMs: options?.loadMoreDebounceMs });
      return { ...bridge, loadMore };
    };
    return { ...handle, useWindow } as QueryHandle<TStored, TScope> & { useWindow: typeof useWindow };
  }
  const destination = config.into as ModelDestination<TStored>;
  const useRowEnsured = (
    rawScope: TScope,
    rowId: string | null | undefined,
    readOpts?: { renderKeys?: readonly (keyof TStored & string)[]; require?: readonly (keyof TStored & string)[] }
  ): EnsuredRowResult<TStored> => {
    const scope = registerScope(rawScope)!;
    const storedData = destination.find(rowId);
    const data = destination.use.find(rowId, readOpts);
    const enabled = data === undefined && rowId != null && (config.enabled?.(scope) ?? true);
    const state = useReader(scope, enabled, true, storedData === undefined);
    const hasData = data !== undefined;
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
      data,
      loadingState: computeLoadingState(computePhase(phaseInput), phaseInput),
      error: state.error,
      refresh: async () => await run(scope, { restart: true, resurrectDestroyed: true })
    };
  };
  return { ...handle, useRowEnsured };
};
