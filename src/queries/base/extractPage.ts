import type { ConnectionResult, ConnectionWithEdges, ConnectionWithNodes, PageInfo } from '../../types';
import { castNodes } from '../../utils/typeBoundary';

const EMPTY_PAGE_INFO: PageInfo = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null
};

const extractPageInfo = (
  raw:
    | {
        hasNextPage?: boolean | null;
        hasPreviousPage?: boolean | null;
        startCursor?: string | null;
        endCursor?: string | null;
      }
    | null
    | undefined
): PageInfo => {
  if (!raw) return EMPTY_PAGE_INFO;

  return {
    hasNextPage: raw.hasNextPage ?? false,
    hasPreviousPage: raw.hasPreviousPage ?? false,
    startCursor: raw.startCursor ?? null,
    endCursor: raw.endCursor ?? null
  };
};

const hasEdges = (connection: ConnectionWithNodes | ConnectionWithEdges | null | undefined): connection is ConnectionWithEdges =>
  Array.isArray((connection as ConnectionWithEdges | null | undefined)?.edges);

const toNodeList = (connection: ConnectionWithNodes | ConnectionWithEdges | null | undefined): unknown[] => {
  if (hasEdges(connection)) {
    const edges = connection.edges ?? [];
    return edges.flatMap(edge => (edge?.node ? [edge.node] : []));
  }

  const nodes = (connection as ConnectionWithNodes | null | undefined)?.nodes ?? [];
  return nodes.filter(Boolean);
};

export const makePageExtractor = <TData, TNode>(
  selectPage: (data: TData) => ConnectionWithNodes | ConnectionWithEdges | null | undefined
): ((data: TData) => ConnectionResult<TNode>) => {
  return (data: TData) => {
    const connection = selectPage(data);
    if (!connection) {
      return { nodes: [], pageInfo: EMPTY_PAGE_INFO };
    }

    const rawNodes = toNodeList(connection);

    return {
      nodes: castNodes<TNode>(rawNodes),
      pageInfo: extractPageInfo(connection.pageInfo)
    };
  };
};
