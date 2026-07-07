"use strict";

import { getDbExtractSink } from "../../core/extract.js";
import { getDbTransport } from "../../core/transport.js";
import { mergeSyncContract, replaceSyncContract } from "../../utils/serverSync.js";
import { makePageExtractor } from "./extractPage.js";
import { buildModelFilter, mergeScopeVars, resolveRequestFilter, resolveRequestScope } from "./shared.js";
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
const applyNodePatch = (nodes, patchNode, pageParam) => {
  if (!patchNode) return;
  for (const [index, node] of nodes.entries()) {
    const patch = patchNode(node, {
      index,
      pageParam
    });
    if (!patch) continue;
    Object.assign(node, patch);
  }
};

/**
 * Execute a single request config outside React.
 * @param config Same config accepted by `useDbSingleRequest`.
 * @returns Selected or mapped result, or null when `read` owns the reactive data.
 */
export const executeDbSingleRequest = async config => {
  const response = await getDbTransport().query({
    query: config.query,
    variables: config.vars
  });
  const data = response.data;
  const selected = config.select(data);
  getDbExtractSink()(config.extract?.({
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
 * Execute one page of an infinite request config outside React.
 * @param config Same config accepted by `useDbInfiniteRequest`.
 * @param pageParam Optional cursor for the page to load.
 * @returns Raw page response data.
 */
export const executeDbInfiniteRequest = async (config, pageParam) => {
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
  const result = await getDbTransport().query({
    query: config.query,
    variables
  });
  const data = result.data;
  const page = extractPage(data);
  const nodes = page.nodes;
  applyNodePatch(nodes, config.patchNode, pageParam);
  if (config.extract) {
    getDbExtractSink()(config.extract({
      data,
      nodes
    }), 'query');
  }
  const modelFilter = buildModelFilter(resolveRequestFilter(config.filter, config.scope), config.currentUserId?.());
  const contract = config.resolveSyncContract ? config.resolveSyncContract({
    pageParam,
    nodes,
    scope: modelFilter
  }) : pageParam !== undefined ? mergeSyncContract('loadMore', modelFilter) : replaceSyncContract('initial', modelFilter);
  config.read.applyServerData(nodes, contract);
  config.read.markFetched?.(modelFilter, {
    empty: nodes.length === 0,
    pageInfo: page.pageInfo
  });
  return data;
};
//# sourceMappingURL=requestRuntime.js.map