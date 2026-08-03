import type {
  DbShape,
  AnyFields,
  FacadeRuntimeModel,
  GraphqlConnectionDefinition,
  GraphqlListDefinition,
  ModelBuildInput,
  ModelStoredValue,
  QueryHandle,
  RelationCursorPage,
  RelationSpec,
  ScopeQueryHandle
} from '../types';

/**
 * The remote half of a declared relation becomes a query handle here. Each declaration kind knows
 * how to read its own payload - one row, a complete list, or a cursor page - so the consumer never
 * assembles nodes, maps cursors, or patches membership after a fetch.
 */
export const compileRemoteRelations = <TShape extends DbShape<any, AnyFields>>(
  runtime: FacadeRuntimeModel<ModelStoredValue<TShape>, ModelBuildInput<TShape>>,
  relations: Record<string, RelationSpec<ModelStoredValue<TShape>, any>>
): Record<
  string,
  | ScopeQueryHandle<ModelStoredValue<TShape>, Record<string, unknown>>
  | QueryHandle<ModelStoredValue<TShape>, Record<string, unknown>, ModelStoredValue<TShape> | undefined>
  | undefined
> => {
  return Object.fromEntries(
    Object.entries(relations).map(([name, definition]) => {
      const remote = definition.remote;
      const query = remote
        ? remote.type === 'single'
          ? (() => {
              const write = remote.write;
              return runtime.query(name, {
                document: remote.document,
                vars: remote.variables,
                select: remote.select,
                write: write
                  ? ({ data, nodes, scope }, plan) =>
                      write({
                        data,
                        nodes,
                        params: scope
                      }, plan)
                  : undefined,
                into: runtime,
                requiredScope: remote.required,
                staleTime: remote.staleTime,
                resumeStaleTime: remote.resumeStaleTime,
                emptyStaleTime: remote.emptyStaleTime,
                persistenceVersion: remote.persistenceVersion,
                refetchOnMount: remote.refetchOnMount
              }) as QueryHandle<ModelStoredValue<TShape>, Record<string, unknown>, ModelStoredValue<TShape> | undefined>;
            })()
          : remote.type === 'list'
            ? (() => {
                const list = remote as GraphqlListDefinition<any, any, any, any, any>;
                const write = list.write;
                return runtime.query(name, {
                  document: list.document,
                  vars: list.variables,
                  select: (data: unknown) => (list.select(data) ?? []).flatMap(node => (node == null ? [] : [list.map ? list.map(node) : node])),
                  write: write
                    ? ({ data, nodes, scope }, plan) =>
                        write({
                          data,
                          nodes,
                          params: scope
                        }, plan)
                    : undefined,
                  into: runtime.scopes[name] as never,
                  coverage: 'complete',
                  requiredScope: list.required,
                  staleTime: list.staleTime,
                  resumeStaleTime: list.resumeStaleTime,
                  emptyStaleTime: list.emptyStaleTime,
                  persistenceVersion: list.persistenceVersion,
                  refetchOnMount: list.refetchOnMount
                }) as ScopeQueryHandle<ModelStoredValue<TShape>, Record<string, unknown>>;
              })()
            : (() => {
                const connection = remote as GraphqlConnectionDefinition<any, any, any, any, any, any>;
                const write = connection.write;
                return runtime.query(name, {
                  document: connection.document,
                  vars: connection.variables,
                  page: (data: unknown): RelationCursorPage => {
                    const value = connection.connection(data);
                    const nodes = value?.nodes
                      ? [...value.nodes].filter((node: unknown) => node != null)
                      : (value?.edges ?? []).flatMap((edge: { node?: unknown } | null | undefined) => (edge?.node == null ? [] : [edge.node]));
                    return {
                      nodes: connection.map ? nodes.map((node: unknown) => connection.map!(node)) : nodes,
                      pageInfo: value?.pageInfo,
                      relationCursor: value && connection.cursor ? connection.cursor(data, value) : undefined
                    };
                  },
                  write: write
                    ? ({ data, nodes, scope }, plan) =>
                        write({
                          data,
                          nodes,
                          params: scope
                        }, plan)
                    : undefined,
                  into: runtime.scopes[name] as never,
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
                  getCursor: connection.cursor ? page => (page as RelationCursorPage).relationCursor ?? null : undefined,
                  mapCursor: connection.mapCursor
                }) as ScopeQueryHandle<ModelStoredValue<TShape>, Record<string, unknown>>;
              })()
        : undefined;
      return [name, query] as const;
    })
  );
};
