"use strict";

/**
 * The remote half of a declared relation becomes a query handle here. Each declaration kind knows
 * how to read its own payload - one row, a complete list, or a cursor page - so the consumer never
 * assembles nodes, maps cursors, or patches membership after a fetch.
 */
export const compileRemoteRelations = (runtime, relations) => {
  return Object.fromEntries(Object.entries(relations ?? {}).map(([name, definition]) => {
    const remote = definition.remote;
    const query = remote ? remote.type === 'single' ? runtime.query(name, {
      document: remote.document,
      vars: remote.variables,
      select: remote.select,
      into: runtime,
      requiredScope: remote.required,
      staleTime: remote.staleTime,
      resumeStaleTime: remote.resumeStaleTime,
      emptyStaleTime: remote.emptyStaleTime,
      persistenceVersion: remote.persistenceVersion,
      refetchOnMount: remote.refetchOnMount
    }) : remote.type === 'list' ? (() => {
      const list = remote;
      return runtime.query(name, {
        document: list.document,
        vars: list.variables,
        select: data => (list.select(data) ?? []).flatMap(node => node == null ? [] : [list.map ? list.map(node) : node]),
        into: runtime.scopes[name],
        coverage: 'complete',
        requiredScope: list.required,
        staleTime: list.staleTime,
        resumeStaleTime: list.resumeStaleTime,
        emptyStaleTime: list.emptyStaleTime,
        persistenceVersion: list.persistenceVersion,
        refetchOnMount: list.refetchOnMount
      });
    })() : (() => {
      const connection = remote;
      return runtime.query(name, {
        document: connection.document,
        vars: connection.variables,
        page: data => {
          const value = connection.connection(data);
          const nodes = value?.nodes ? [...value.nodes].filter(node => node != null) : (value?.edges ?? []).flatMap(edge => edge?.node == null ? [] : [edge.node]);
          return {
            nodes: connection.map ? nodes.map(node => connection.map(node)) : nodes,
            pageInfo: value?.pageInfo,
            relationCursor: value && connection.cursor ? connection.cursor(data, value) : undefined
          };
        },
        into: runtime.scopes[name],
        coverage: connection.coverage,
        requiredScope: connection.required,
        staleTime: connection.staleTime,
        resumeStaleTime: connection.resumeStaleTime,
        emptyStaleTime: connection.emptyStaleTime,
        persistenceVersion: connection.persistenceVersion,
        refetchOnMount: connection.refetchOnMount,
        maxPages: connection.maxPages,
        direction: connection.direction,
        cursorVar: connection.cursorVar,
        getCursor: connection.cursor ? page => page.relationCursor ?? null : undefined,
        mapCursor: connection.mapCursor
      });
    })() : undefined;
    return [name, query];
  }));
};
//# sourceMappingURL=facadeRemoteQueries.js.map