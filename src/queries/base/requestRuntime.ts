import type { BaseQueryCollection, DbRequestInfiniteConfig, DbRequestSingleConfig, DbRequestSingleData, InfiniteSyncContractResolverContext, SyncContract } from '../../types';
import { getDbExtractSink } from '../../core/extract';
import { deriveDbKey } from '../../core/deriveDbKey';
import { getDbTransport } from '../../core/transport';
import { stableSerialize } from '../../core/serialize';
import { mergeSyncContract, replaceSyncContract } from '../../utils/serverSync';
import { makePageExtractor } from './extractPage';
import { buildModelFilter, mergeScopeVars, resolveRequestFilter, resolveRequestScope } from './shared';

type InfiniteRequestPatchState = {
  nextGlobalIndex: number;
};

const infinitePatchStates = new Map<string, InfiniteRequestPatchState>();

/**
 * Alternate infinite-request resolver that merges both the initial and every subsequently loaded page
 * into the target scope, instead of replacing the scope on the initial page.
 * Pass this explicitly via `resolveSyncContract` when a request's initial page should not clear rows
 * already present in the scope (e.g. a paginated thread read alongside other writers into the same scope).
 */
export const mergeInitialSyncContract = <TNode>({ pageParam, scope, snapshotSeq }: InfiniteSyncContractResolverContext<TNode>): SyncContract =>
  mergeSyncContract(pageParam === undefined ? 'initial' : 'loadMore', scope, snapshotSeq);

/**
 * Default infinite-request resolver: replace the target scope on the initial page, then merge every
 * subsequently loaded page into it. `runDbInfiniteQueryDirect`/`useDbInfiniteRequest` use this whenever
 * a config omits `resolveSyncContract` - pass it explicitly only where a call site needs to name the
 * default resolution (e.g. composing it with other resolver logic).
 */
export const replaceInitialSyncContract = <TNode>({ pageParam, scope, snapshotSeq }: InfiniteSyncContractResolverContext<TNode>): SyncContract =>
  pageParam === undefined ? replaceSyncContract('initial', scope, snapshotSeq) : mergeSyncContract('loadMore', scope, snapshotSeq);

const applySingleSync = <TSelected>(selected: TSelected, sync: DbRequestSingleConfig<unknown, unknown, TSelected>['sync'], snapshotSeq?: number): void => {
  if (!sync || selected == null) return;

  if (typeof sync === 'function') {
    sync(selected);
    return;
  }

  const selectedItems = Array.isArray(selected) ? selected : [selected];
  if (selectedItems.length === 0) return;

  sync.model.applyServerData(selectedItems, mergeSyncContract(sync.contract, undefined, snapshotSeq));
};

const isEmptySelectedPayload = (selected: unknown): boolean => selected == null || (Array.isArray(selected) && selected.length === 0);
const identitySelect = <TResponse, TSelected>(data: TResponse): TSelected => data as unknown as TSelected;

const resolvePatchState = (key: string, patchState?: InfiniteRequestPatchState): InfiniteRequestPatchState => {
  if (patchState) return patchState;
  const existing = infinitePatchStates.get(key);
  if (existing) return existing;
  const next = { nextGlobalIndex: 0 };
  infinitePatchStates.set(key, next);
  return next;
};

const applyNodePatch = <TNode>(nodes: TNode[], patchNode: DbRequestInfiniteConfig<unknown, TNode>['patchNode'], patchState: InfiniteRequestPatchState, pageParam?: string): void => {
  if (pageParam === undefined) {
    patchState.nextGlobalIndex = 0;
  }
  if (!patchNode) return;

  for (const [index, node] of nodes.entries()) {
    const patch = patchNode(node, { index, globalIndex: patchState.nextGlobalIndex, pageParam });
    patchState.nextGlobalIndex += 1;
    if (!patch) continue;
    Object.assign(node as Record<string, unknown>, patch);
  }
};

/**
 * Run a single request config outside React.
 * @param config Same config accepted by `useDbSingleRequest`; `key`, `enabled`, `staleTime`, `gcTime`, and `refetchOnMount` are hook-only.
 * @returns Selected or mapped result, or null when `read` owns the reactive data.
 */
export const runDbQueryDirect = async <
  TResponse,
  TResult = unknown,
  TSelected = unknown,
  TVariables = Record<string, unknown>,
  TRead extends BaseQueryCollection | undefined = BaseQueryCollection | undefined
>(
  config: DbRequestSingleConfig<TResponse, TResult, TSelected, TVariables, TRead>
): Promise<DbRequestSingleData<TResult, TSelected, TRead>> => {
  const snapshotSeq = typeof config.sync === 'object' ? config.sync.model.getCollectionWriteSeq?.() : undefined;
  const response = await getDbTransport().query<TResponse, Record<string, unknown>>({ query: config.query, variables: config.vars as Record<string, unknown> | undefined });
  const data = response.data;
  const selected = (config.select ?? identitySelect<TResponse, TSelected>)(data);
  getDbExtractSink()(config.extract?.({ data, selected }), config.extractSource ?? 'query');
  applySingleSync(selected, config.sync, snapshotSeq);

  if (config.read?.model.markFetched) {
    if ('id' in config.read) {
      config.read.model.markFetched(config.read.id ? { id: config.read.id } : undefined, { empty: isEmptySelectedPayload(selected) });
    } else {
      config.read.model.markFetched(undefined, { empty: isEmptySelectedPayload(selected) });
    }
  }

  if (config.read) {
    return null as DbRequestSingleData<TResult, TSelected, TRead>;
  }

  return (config.map ? config.map(selected) : selected) as DbRequestSingleData<TResult, TSelected, TRead>;
};

/**
 * Run one page of an infinite request config outside React.
 * @param config Same config accepted by `useDbInfiniteRequest`.
 * @param pageParam Optional cursor for the page to load.
 * @returns Raw page response data.
 */
export const runDbInfiniteQueryDirect = async <TResponse, TNode, TVariables = Record<string, unknown>>(
  config: DbRequestInfiniteConfig<TResponse, TNode, TVariables>,
  pageParam?: string,
  patchState?: InfiniteRequestPatchState
): Promise<TResponse> => {
  const extractPage = makePageExtractor<TResponse, TNode>(config.selectPage);
  const requestScope = resolveRequestScope(config.scope);
  const modelFilter = buildModelFilter(resolveRequestFilter(config.filter, config.scope), config.currentUserId?.());
  const derivedPatchKey = config.read._dbModel
    ? deriveDbKey(config.read._dbModel as never, config.read._dbScope?.(modelFilter))
    : ['db-direct', config.query, modelFilter];
  const patchStateKey = stableSerialize(config.key ?? derivedPatchKey);
  const resolvedPatchState = resolvePatchState(patchStateKey, patchState);
  let variables = mergeScopeVars(config.vars, requestScope) ?? {};

  if (pageParam) {
    const pageVars = config.getPageVars ? config.getPageVars(pageParam) : config.direction === 'backward' ? { before: pageParam } : { after: pageParam };
    variables = { ...variables, ...pageVars };
  }

  const snapshotSeq = config.read._dbModel?.getCollectionWriteSeq?.();
  const result = await getDbTransport().query<TResponse, Record<string, unknown>>({ query: config.query, variables });
  const data = result.data;
  const page = extractPage(data);
  const nodes = page.nodes;
  applyNodePatch(nodes, config.patchNode, resolvedPatchState, pageParam);

  if (config.extract) {
    getDbExtractSink()(config.extract({ data, nodes }), config.extractSource ?? 'query');
  }

  const contract = (config.resolveSyncContract ?? replaceInitialSyncContract)({ pageParam, nodes, scope: modelFilter, snapshotSeq });
  config.read.applyServerData(nodes, contract);
  config.read.markFetched?.(modelFilter, { empty: nodes.length === 0, pageInfo: page.pageInfo });

  return data;
};
