"use strict";

import { castNodes } from "../../utils/typeBoundary.js";
const EMPTY_PAGE_INFO = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null
};
const extractPageInfo = raw => {
  if (!raw) return EMPTY_PAGE_INFO;
  return {
    hasNextPage: raw.hasNextPage ?? false,
    hasPreviousPage: raw.hasPreviousPage ?? false,
    startCursor: raw.startCursor ?? null,
    endCursor: raw.endCursor ?? null
  };
};
const hasEdges = connection => Array.isArray(connection?.edges);
const toNodeList = connection => {
  if (hasEdges(connection)) {
    const edges = connection.edges ?? [];
    return edges.flatMap(edge => edge?.node ? [edge.node] : []);
  }
  const nodes = connection?.nodes ?? [];
  return nodes.filter(Boolean);
};
export const makePageExtractor = selectPage => {
  return data => {
    const connection = selectPage(data);
    if (!connection) {
      return {
        nodes: [],
        pageInfo: EMPTY_PAGE_INFO
      };
    }
    const rawNodes = toNodeList(connection);
    return {
      nodes: castNodes(rawNodes),
      pageInfo: extractPageInfo(connection.pageInfo)
    };
  };
};
//# sourceMappingURL=extractPage.js.map