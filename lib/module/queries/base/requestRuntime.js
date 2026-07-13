"use strict";

import { getDbExtractSink } from "../../core/extract.js";
import { getDbTransport } from "../../core/transport.js";
import { mergeSyncContract, replaceSyncContract } from "../../utils/serverSync.js";
import { makePageExtractor } from "./extractPage.js";
import { buildModelFilter, mergeScopeVars, resolveRequestFilter, resolveRequestScope } from "./shared.js";
const infinitePatchStates = new WeakMap();

/**
 * Alternate infinite-request resolver that merges both the initial and every subsequently loaded page
 * into the target scope, instead of replacing the scope on the initial page.
 * Pass this explicitly via `resolveSyncContract` when a request's initial page should not clear rows
 * already present in the scope (e.g. a paginated thread read alongside other writers into the same scope).
 */
export const mergeInitialSyncContract = ({
  pageParam,
  scope
}) => mergeSyncContract(pageParam === undefined ? 'initial' : 'loadMore', scope);

/**
 * Default infinite-request resolver: replace the target scope on the initial page, then merge every
 * subsequently loaded page into it. `runDbInfiniteQueryDirect`/`useDbInfiniteRequest` use this whenever
 * a config omits `resolveSyncContract` - pass it explicitly only where a call site needs to name the
 * default resolution (e.g. composing it with other resolver logic).
 */
export const replaceInitialSyncContract = ({
  pageParam,
  scope,
  protectAfterSeq
}) => pageParam === undefined ? replaceSyncContract('initial', scope, protectAfterSeq) : mergeSyncContract('loadMore', scope);
const applySingleSync = (selected, sync) => {
  if (!sync || selected == null) return;
  if (typeof sync === 'function') {
    sync(selected);
    return;
  }
  const selectedItems = Array.isArray(selected) ? selected : [selected];
  if (selectedItems.length === 0) return;
  sync.model.applyServerData(selectedItems, mergeSyncContract(sync.contract));
};
const isEmptySelectedPayload = selected => selected == null || Array.isArray(selected) && selected.length === 0;
const identitySelect = data => data;
const resolvePatchState = (config, patchState) => {
  if (patchState) return patchState;
  const weakConfig = config;
  const existing = infinitePatchStates.get(weakConfig);
  if (existing) return existing;
  const next = {
    nextGlobalIndex: 0
  };
  infinitePatchStates.set(weakConfig, next);
  return next;
};
const applyNodePatch = (nodes, patchNode, patchState, pageParam) => {
  if (pageParam === undefined) {
    patchState.nextGlobalIndex = 0;
  }
  if (!patchNode) return;
  for (const [index, node] of nodes.entries()) {
    const patch = patchNode(node, {
      index,
      globalIndex: patchState.nextGlobalIndex,
      pageParam
    });
    patchState.nextGlobalIndex += 1;
    if (!patch) continue;
    Object.assign(node, patch);
  }
};

/**
 * Run a single request config outside React.
 * @param config Same config accepted by `useDbSingleRequest`; `key`, `enabled`, `staleTime`, `gcTime`, and `refetchOnMount` are hook-only.
 * @returns Selected or mapped result, or null when `read` owns the reactive data.
 */
export const runDbQueryDirect = async config => {
  const response = await getDbTransport().query({
    query: config.query,
    variables: config.vars
  });
  const data = response.data;
  const selected = (config.select ?? identitySelect)(data);
  getDbExtractSink()(config.extract?.({
    data,
    selected
  }), config.extractSource ?? 'query');
  applySingleSync(selected, config.sync);
  if (config.read?.model.markFetched) {
    if ('id' in config.read) {
      config.read.model.markFetched(config.read.id ? {
        id: config.read.id
      } : undefined, {
        empty: isEmptySelectedPayload(selected)
      });
    } else {
      config.read.model.markFetched(undefined, {
        empty: isEmptySelectedPayload(selected)
      });
    }
  }
  if (config.read) {
    return null;
  }
  return config.map ? config.map(selected) : selected;
};

/**
 * Run one page of an infinite request config outside React.
 * @param config Same config accepted by `useDbInfiniteRequest`.
 * @param pageParam Optional cursor for the page to load.
 * @returns Raw page response data.
 */
export const runDbInfiniteQueryDirect = async (config, pageParam, patchState) => {
  const resolvedPatchState = resolvePatchState(config, patchState);
  const extractPage = makePageExtractor(config.selectPage);
  const requestScope = resolveRequestScope(config.scope);
  let variables = mergeScopeVars(config.vars, requestScope) ?? {};
  if (pageParam) {
    const pageVars = config.getPageVars ? config.getPageVars(pageParam) : config.direction === 'backward' ? {
      before: pageParam
    } : {
      after: pageParam
    };
    variables = {
      ...variables,
      ...pageVars
    };
  }
  const queryStartSeq = config.read._dbModel?.getCollectionWriteSeq?.();
  const result = await getDbTransport().query({
    query: config.query,
    variables
  });
  const data = result.data;
  const page = extractPage(data);
  const nodes = page.nodes;
  applyNodePatch(nodes, config.patchNode, resolvedPatchState, pageParam);
  if (config.extract) {
    getDbExtractSink()(config.extract({
      data,
      nodes
    }), config.extractSource ?? 'query');
  }
  const modelFilter = buildModelFilter(resolveRequestFilter(config.filter, config.scope), config.currentUserId?.());
  const contract = (config.resolveSyncContract ?? replaceInitialSyncContract)({
    pageParam,
    nodes,
    scope: modelFilter,
    protectAfterSeq: queryStartSeq
  });
  config.read.applyServerData(nodes, contract);
  config.read.markFetched?.(modelFilter, {
    empty: nodes.length === 0,
    pageInfo: page.pageInfo
  });
  return data;
};
//# sourceMappingURL=requestRuntime.js.map