"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.runDbQueryDirect = exports.mergeInitialSyncContract = exports.executeDbSingleRequest = exports.executeDbInfiniteRequest = void 0;
var _extract = require("../../core/extract.js");
var _transport = require("../../core/transport.js");
var _serverSync = require("../../utils/serverSync.js");
var _extractPage = require("./extractPage.js");
var _shared = require("./shared.js");
const infinitePatchStates = new WeakMap();

/** Resolver for infinite requests that should merge initial and loaded pages into the target scope. */
const mergeInitialSyncContract = ({
  pageParam,
  scope
}) => (0, _serverSync.mergeSyncContract)(pageParam === undefined ? 'initial' : 'loadMore', scope);
exports.mergeInitialSyncContract = mergeInitialSyncContract;
const applySingleSync = (selected, sync) => {
  if (!sync || selected == null) return;
  if (typeof sync === 'function') {
    sync(selected);
    return;
  }
  const selectedItems = Array.isArray(selected) ? selected : [selected];
  if (selectedItems.length === 0) return;
  sync.model.applyServerData(selectedItems, (0, _serverSync.mergeSyncContract)(sync.contract));
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
 * Execute a single request config outside React.
 * @param config Same config accepted by `useDbSingleRequest`.
 * @returns Selected or mapped result, or null when `read` owns the reactive data.
 */
const executeDbSingleRequest = async config => {
  const response = await (0, _transport.getDbTransport)().query({
    query: config.query,
    variables: config.vars
  });
  const data = response.data;
  const selected = (config.select ?? identitySelect)(data);
  (0, _extract.getDbExtractSink)()(config.extract?.({
    data,
    selected
  }), 'query');
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
 * Run a single request config outside React.
 * @param config Same config accepted by `useDbSingleRequest`; `key`, `enabled`, `staleTime`, `gcTime`, `inactive`, and `refetchOnMount` are hook-only.
 * @returns Selected or mapped result, or null when `read` owns the reactive data.
 */
exports.executeDbSingleRequest = executeDbSingleRequest;
const runDbQueryDirect = exports.runDbQueryDirect = executeDbSingleRequest;

/**
 * Execute one page of an infinite request config outside React.
 * @param config Same config accepted by `useDbInfiniteRequest`.
 * @param pageParam Optional cursor for the page to load.
 * @returns Raw page response data.
 */
const executeDbInfiniteRequest = async (config, pageParam, patchState) => {
  const resolvedPatchState = resolvePatchState(config, patchState);
  const extractPage = (0, _extractPage.makePageExtractor)(config.selectPage);
  const requestScope = (0, _shared.resolveRequestScope)(config.scope);
  let variables = (0, _shared.mergeScopeVars)(config.vars, requestScope) ?? {};
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
  const result = await (0, _transport.getDbTransport)().query({
    query: config.query,
    variables
  });
  const data = result.data;
  const page = extractPage(data);
  const nodes = page.nodes;
  applyNodePatch(nodes, config.patchNode, resolvedPatchState, pageParam);
  if (config.extract) {
    (0, _extract.getDbExtractSink)()(config.extract({
      data,
      nodes
    }), 'query');
  }
  const modelFilter = (0, _shared.buildModelFilter)((0, _shared.resolveRequestFilter)(config.filter, config.scope), config.currentUserId?.());
  const contract = config.resolveSyncContract ? config.resolveSyncContract({
    pageParam,
    nodes,
    scope: modelFilter
  }) : pageParam === undefined ? (0, _serverSync.replaceSyncContract)('initial', modelFilter) : (0, _serverSync.mergeSyncContract)('loadMore', modelFilter);
  config.read.applyServerData(nodes, contract);
  config.read.markFetched?.(modelFilter, {
    empty: nodes.length === 0,
    pageInfo: page.pageInfo
  });
  return data;
};
exports.executeDbInfiniteRequest = executeDbInfiniteRequest;
//# sourceMappingURL=requestRuntime.js.map