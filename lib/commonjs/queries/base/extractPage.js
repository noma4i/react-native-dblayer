"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.makePageExtractor = void 0;
var _typeBoundary = require("../../utils/typeBoundary.js");
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
const makePageExtractor = selectPage => {
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
      nodes: (0, _typeBoundary.castNodes)(rawNodes),
      pageInfo: extractPageInfo(connection.pageInfo)
    };
  };
};
exports.makePageExtractor = makePageExtractor;
//# sourceMappingURL=extractPage.js.map