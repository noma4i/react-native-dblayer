import type { DocumentNode, OperationDefinitionNode } from 'graphql';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { DbGraphQLDocument, DbReadOptions, LoadingState } from '../types';
import { computeLoadingState, computePhase } from '../queries/base/loadingState';
import type { JournalOp } from '../core/apply/journal';
import { buildScopeKey } from '../core/compileDbWhere';
import { compositeKey } from '../core/serialize';
import { registerModelInvalidation } from '../core/invalidationRegistry';
import { isNonArrayRecord, isRecord } from '../utils/normalizeHelpers';
import { getApplyRuntime, getDbRuntimeConfig } from './configure';
import { getDbLogger } from '../core/logger';
import { responseDataOrThrow } from '../core/transport';
import type { ScopeHandle } from './defineModel';
import type { ScopeCoverage } from './scope';
import { getInternalModelHandle, getInternalScopeHandle, hasInternalScopeHandle } from '../core/internalHandles';
import { createFetchLedger } from '../core/fetch/fetchLedger';
import { isFetchNetworkOnline, registerFetchLedger, subscribeFetchNetwork } from '../core/fetch/fetchLedgerRegistry';
import { registerReset } from '../core/reset';
type PageInfoLike = { hasNextPage?: boolean; endCursor?: string | null; hasPreviousPage?: boolean; startCursor?: string | null };
type ConnectionLike = { nodes?: unknown[]; edges?: Array<{ node?: unknown } & Record<string, unknown>>; pageInfo?: PageInfoLike };
export type QueryResult<T> = {
  data: T[] | T | undefined; loadingState: LoadingState; error: Error | null; hasNextPage: boolean;
  isFetchingNextPage: boolean; fetchNextPage: () => void; refetch: () => Promise<void>;
};
export type EnsuredRowResult<TStored> = {
  row: TStored | undefined; loadingState: LoadingState; error: Error | null; refetch: () => Promise<void>;
};
export type QueryHandle<TStored, TScope> = {
  use(scope: TScope | null, options?: { enabled?: boolean }): QueryResult<TStored>; fetch(scope: TScope | null): Promise<void>; invalidate(scope?: TScope): void;
};
export type EnsuredRowQueryHandle<TStored, TScope> = QueryHandle<TStored, TScope> & {
  useRowEnsured(scope: TScope, rowId: string | null | undefined, readOpts?: DbReadOptions<TStored> & { renderKeys?: readonly (keyof TStored & string)[] }): EnsuredRowResult<TStored>;
};
type PlanRowsSink = { modelId: string };
export type ExtractSink = { into: PlanRowsSink; rows: unknown[] };
/**
 * Create one extract sink only when a row exists; pair with the `{ into, rows }` extract contract.
 *
 * @param into Extract destination.
 * @param row Optional source row.
 * @returns One extract sink, or an empty list.
 */
export const intoIf = (into: ExtractSink['into'], row: unknown): ExtractSink[] => (row == null ? [] : [{ into, rows: [row] }]);
type ScopeDestination<TStored, TScope> = ScopeHandle<TStored & { id: string }, TScope>;
type ModelDestination<TStored> = {
  modelId: string;
  get?: (id: string | null | undefined) => TStored | undefined;
  use: { find(id: string | null | undefined, opts?: DbReadOptions<TStored> & { renderKeys?: readonly (keyof TStored & string)[] }): TStored | undefined };
};
type QueryDestination<TStored, TScope> = ScopeDestination<TStored, TScope> | ModelDestination<TStored>;
type QueryConfig<TResponse, TVars, TScope, TStored> = {
  document: DbGraphQLDocument<TResponse, TVars>;
  key?: string;
  vars?: (scope: TScope) => TVars;
  page?: (data: TResponse) => ConnectionLike;
  select?: (data: TResponse) => unknown;
  into: QueryDestination<TStored, TScope>;
  coverage?: ScopeCoverage;
  edge?: (edgeSource: unknown) => Record<string, unknown> | undefined;
  extract?: (ctx: { data: TResponse; nodes: unknown[] }) => ExtractSink[];
  map?: (selected: unknown) => unknown;
  enabled?: (scope: TScope) => boolean;
  staleTime?: number;
  resumeStaleTime?: number | null;
  emptyStaleTime?: number;
  refetchOnMount?: boolean;
  maxPages?: number;
  direction?: 'forward' | 'backward';
  cursorVar?: string;
  getCursor?: (page: ConnectionLike) => string | null;
  mapCursor?: (cursor: string) => unknown;
};
type PageMeta = { endCursor: string | null; hasNextPage: boolean; count: number };
type RequestState = { isFetching: boolean; isFetchingNextPage: boolean; isFetched: boolean; isPaused: boolean; retryAttempt: number; error: Error | null; hasNextPage: boolean };
const issuedResetSeqByBucket = new Map<string, number>();
const appliedResetSeqByBucket = new Map<string, number>();
registerReset(() => { issuedResetSeqByBucket.clear(); appliedResetSeqByBucket.clear(); });
const operationKey = (document: DbGraphQLDocument<any, any>, override?: string): string => {
  if (override) return override;
  const operation = (document as DocumentNode).definitions?.find((definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition');
  const name = operation?.name?.value;
  if (!name) throw new Error('defineQuery requires a named operation or an explicit key'); return name;
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
/** Define a coordinator-owned GraphQL query that applies results into the local model store. */
export const defineQuery = <TResponse, TVars, TScope, TStored>(
  config: QueryConfig<TResponse, TVars, TScope, TStored>
): QueryHandle<TStored, TScope> | EnsuredRowQueryHandle<TStored, TScope> => {
  const keyName = operationKey(config.document, config.key);
  const registeredScopes = new Map<string, TScope>();
  const states = new Map<string, RequestState>();
  const listeners = new Map<string, Set<() => void>>();
  const versions = new Map<string, number>();
  const coverage = config.coverage ?? (config.page ? 'page' : 'complete');
  const destinationModelId = (config.into as { modelId?: string }).modelId ?? keyName;
  const stateOf = (key: string): RequestState => states.get(key) ?? { isFetching: false, isFetchingNextPage: false, isFetched: false, isPaused: false, retryAttempt: 0, error: null, hasNextPage: false };
  const emit = (key: string): void => {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const setState = (key: string, next: Partial<RequestState>): void => {
    states.set(key, { ...stateOf(key), ...next });
    emit(key);
  };
  const subscribe = (key: string, listener: () => void): (() => void) => {
    const keyListeners = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, keyListeners);
    keyListeners.add(listener);
    return () => {
      keyListeners.delete(listener);
      if (keyListeners.size === 0) listeners.delete(key);
    };
  };
  let ledger!: ReturnType<typeof createFetchLedger>;
  ledger = createFetchLedger({
    now: Date.now,
    retry: getDbRuntimeConfig().defaults.retry?.query ?? {},
    isOnline: isFetchNetworkOnline,
    onStamp: emit,
    maxEntries: Number.MAX_SAFE_INTEGER
  });
  registerFetchLedger(ledger);
  registerReset(() => { registeredScopes.clear(); issuedResetSeqByBucket.clear(); appliedResetSeqByBucket.clear(); states.clear(); versions.clear(); });
  const ledgerKeyOf = (scope: TScope): string => compositeKey(keyName, buildScopeKey(scope));
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
    const ops: JournalOp[] = [];
    const rows = isScopeDestination(config.into) ? pairs.map(pair => ({ row: pair.node as TStored & { id: string }, edge: config.edge?.(pair.edgeSource) })) : [];
    if (isScopeDestination(config.into)) ops.push(...getInternalScopeHandle(config.into).planApply(scope, rows, coverage, { resetOrder }));
    else ops.push(...getInternalModelHandle(config.into).planRows(nodes as TStored[], resurrectDestroyed ? { origin: 'event' as const } : undefined));
    for (const sink of config.extract?.({ data, nodes }) ?? []) ops.push(...getInternalModelHandle(sink.into).planRows(sink.rows));
    if (ops.length > 0) getApplyRuntime().apply(ops);
    const committedRows = isScopeDestination(config.into) ? rows.map(entry => entry.row) : nodes;
    const ids = committedRows.flatMap(row => (isRecord(row) && row.id != null ? [compositeKey(destinationModelId, String(row.id))] : []));
    return { meta: pageMetaOf(config.page ? config.page(data) : null), ids };
  };
  const execute = async (scope: TScope, key: string, resurrectDestroyed: boolean, context: { cursor: string | null; attempt: number; isCurrent: () => boolean }) => {
    const cursorVar = config.cursorVar ?? (config.direction === 'backward' ? 'before' : 'after');
    const variables = { ...((config.vars?.(scope) ?? {}) as Record<string, unknown>), ...(context.cursor != null ? { [cursorVar]: config.mapCursor ? config.mapCursor(context.cursor) : context.cursor } : {}) };
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
    if (!context.isCurrent()) return { applied: false as const };
    const applied = appliedResetSeqByBucket.get(guardKey) ?? 0;
    if ((reset && issued < applied) || (!reset && issued < (issuedResetSeqByBucket.get(guardKey) ?? 0))) return { applied: false as const };
    if (reset) appliedResetSeqByBucket.set(guardKey, issued);
    const result = applyResponse(scope, data, reset, resurrectDestroyed);
    setState(key, { hasNextPage: result.meta.hasNextPage });
    return config.page
      ? { applied: true as const, count: result.meta.count, ids: result.ids, cursor: result.meta.hasNextPage ? result.meta.endCursor : null }
      : { applied: true as const, count: result.meta.count, ids: result.ids };
  };
  const staleTimeOf = (key: string): number => {
    const entry = ledger.read(key);
    const defaults = getDbRuntimeConfig().defaults;
    return entry?.lastCount === 0 && (config.emptyStaleTime ?? defaults.emptyStaleTime) != null ? (config.emptyStaleTime ?? defaults.emptyStaleTime)! : (config.staleTime ?? defaults.staleTime ?? 0);
  };
  const run = async (scope: TScope, options: { restart: boolean; resurrectDestroyed?: boolean; nextPage?: boolean; propagateFailure?: boolean }): Promise<void> => {
    if (config.enabled && !config.enabled(scope)) return;
    const key = ledgerKeyOf(scope);
    if (options.restart) ledger.invalidate(key);
    setState(key, { isFetching: true, isFetchingNextPage: options.nextPage === true, isPaused: false, error: null, retryAttempt: 0 });
    let lastError: Error | null = null;
    const status = await ledger.run(key, async context => {
      setState(key, { retryAttempt: context.attempt - 1 });
      try {
        return await execute(scope, key, options.resurrectDestroyed === true, context);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    });
    setState(key, {
      isFetching: false,
      isFetchingNextPage: false,
      isPaused: status === 'offline',
      isFetched: stateOf(key).isFetched || status === 'applied' || status === 'failed',
      retryAttempt: 0,
      error: status === 'failed' ? lastError : null
    });
    if (status === 'failed' && options.propagateFailure) throw lastError ?? new Error('react-native-dblayer: query failed without an error');
  };
  const fetch = async (scope: TScope | null): Promise<void> => {
    if (!registerScope(scope)) return;
    await run(scope, { restart: true, propagateFailure: true });
  };
  const invalidate = (scope?: TScope): void => {
    const invalidateScope = (registered: TScope) => {
      const key = ledgerKeyOf(registered);
      ledger.invalidate(key);
      void ledger.refetchKey(key);
    };
    if (scope === undefined) {
      for (const registered of registeredScopes.values()) invalidateScope(registered);
      return;
    }
    registerScope(scope);
    for (const registered of registeredScopes.values()) if (matchesPartialScope(registered, scope)) invalidateScope(registered);
  };
  if (destinationModelId) registerModelInvalidation(destinationModelId, scope => invalidate(scope as TScope | undefined));
  const useVersion = (key: string): number => useSyncExternalStore(listener => subscribe(key, listener), () => versions.get(key) ?? 0, () => 0);
  const useDestinationRows: (scope: TScope | null) => TStored[] | undefined = isScopeDestination(config.into)
    ? scope => (config.into as ScopeDestination<TStored, TScope>).use(scope) as TStored[]
    : () => undefined;
  const useReader = (scope: TScope | null, enabled: boolean, resurrectDestroyed: boolean, forceAbsentRefetch: boolean): RequestState => {
    const key = scope === null ? compositeKey(keyName, 'inactive') : ledgerKeyOf(scope);
    const version = useVersion(key);
    const mountedKey = useRef<string | null>(null);
    const forcedRefetch = useRef(false);
    const state = stateOf(key);
    if (mountedKey.current !== key) forcedRefetch.current = false;
    useEffect(() => {
      if (scope === null || !enabled) return;
      const resumeWindow = (): number | null => config.resumeStaleTime === undefined ? getDbRuntimeConfig().defaults.resumeStaleTime : config.resumeStaleTime;
      const markResumeStale = (): boolean => {
        const window = resumeWindow();
        if (window === null || ledger.isFresh(key, window)) return false;
        ledger.invalidate(key);
        return true;
      };
      const release = ledger.retain(key, () => run(scope, { restart: false, resurrectDestroyed }), markResumeStale);
      const firstMount = mountedKey.current !== key;
      mountedKey.current = key;
      const canRefetch = !firstMount || !state.isFetched || config.refetchOnMount !== false;
      const shouldFetch = firstMount && canRefetch;
      if (shouldFetch && !ledger.isFresh(key, staleTimeOf(key)) && !state.isFetching) {
        void run(scope, { restart: false, resurrectDestroyed }).catch(() => {});
      }
      if (forceAbsentRefetch && state.isFetched && !state.isFetching && !forcedRefetch.current) {
        forcedRefetch.current = true;
        void run(scope, { restart: true, resurrectDestroyed });
      }
      const unsubscribeOnline = subscribeFetchNetwork(() => {
        if (isFetchNetworkOnline() && !ledger.isFresh(key, staleTimeOf(key))) void run(scope, { restart: false, resurrectDestroyed }).catch(() => {});
      });
      return () => {
        unsubscribeOnline();
        release();
      };
    }, [enabled, forceAbsentRefetch, key, resurrectDestroyed, scope, version]);
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
  const use = (scope: TScope | null, options?: { enabled?: boolean }): QueryResult<TStored> => {
    registerScope(scope);
    const enabled = scope !== null && (config.enabled?.(scope) ?? true) && (options?.enabled ?? true);
    const state = useReader(scope, enabled, false, false);
    return buildResult(useDestinationRows(scope), enabled, state, scope);
  };
  const handle: QueryHandle<TStored, TScope> = { use, fetch, invalidate };
  if (isScopeDestination(config.into)) return handle;
  const destination = config.into as ModelDestination<TStored>;
  const useRowEnsured = (scope: TScope, rowId: string | null | undefined, readOpts?: DbReadOptions<TStored> & { renderKeys?: readonly (keyof TStored & string)[] }): EnsuredRowResult<TStored> => {
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
    return { row, loadingState: computeLoadingState(computePhase(phaseInput), phaseInput), error: state.error, refetch: async () => await run(scope, { restart: true, resurrectDestroyed: true }) };
  };
  return { ...handle, useRowEnsured };
};
