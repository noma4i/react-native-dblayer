import { configureDb, defineModelRuntime, defineQuery, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; label: string };

const namedDocument = {
  kind: 'Document',
  definitions: [{ kind: 'OperationDefinition', operation: 'query', name: { kind: 'Name', value: 'QueryEdgeRows' } }]
} as never;

const createRows = (suffix: string) =>
  defineModelRuntime({
    id: `SpecQueryEdges${suffix}`,
    name: `SpecQueryEdges${suffix}`,
    fields: { label: f.str() }
  });

describe('query definition edges', () => {
  it('derives a key from a named operation and rejects an unnamed operation', () => {
    setupSpecRuntime();
    const rows = createRows('OperationKey');

    expect(() =>
      defineQuery({
        document: { kind: 'Document', definitions: [] } as never,
        into: rows
      })
    ).toThrow('defineQuery requires a named operation or an explicit key');
    expect(() => defineQuery({ document: namedDocument, into: rows })).not.toThrow();
  });

  it('rejects connection shorthand combined with page or select', () => {
    setupSpecRuntime();
    const rows = createRows('ConnectionConflict');
    const connection = (data: { rows: { nodes: Row[] } }) => data.rows;

    expect(() => defineQuery({ document: namedDocument, key: 'connection-select', into: rows, connection, select: data => data.rows })).toThrow(
      'defineQuery: connection is mutually exclusive with page/select'
    );
    expect(() => defineQuery({ document: namedDocument, key: 'connection-page', into: rows, connection, page: data => data.rows })).toThrow(
      'defineQuery: connection is mutually exclusive with page/select'
    );
  });

  it('lands dense edge nodes and treats a selected record as one result', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          rows: {
            edges: [{ node: { id: 'row-1', label: 'first' } }, null, { node: null }]
          }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('Edges');
    const query = defineQuery<{ rows: { edges: Array<{ node: Row | null } | null> } }, Record<string, never>, Record<string, never>, Row>({
      document: namedDocument,
      key: 'query-edges',
      into: rows,
      select: data => data.rows
    });

    await query.fetch({});

    expect(query.read({})).toEqual({ id: 'row-1', label: 'first' });
    expect(rows.find('row-1')).toEqual({ id: 'row-1', label: 'first' });
  });

  it('lands a plain selected row and ignores a null selection', async () => {
    let response: { row: Row | null } = { row: { id: 'row-1', label: 'first' } };
    const storage = createMemoryPlane();
    const transport = createMockTransport({ query: async <TData,>() => ({ data: response as TData }) });
    configureDb({ storage, transport });
    const rows = createRows('SingleAndNull');
    const query = defineQuery<{ row: Row | null }, Record<string, never>, Record<string, never>, Row>({
      document: namedDocument,
      key: 'query-single-null',
      into: rows,
      select: data => data.row
    });

    await query.fetch({});
    expect(query.read({})).toEqual({ id: 'row-1', label: 'first' });

    response = { row: null };
    await query.fetch({});
    expect(query.read({})).toBeUndefined();
  });

  it('[F46] compacts dead ids out of an imperative read instead of returning undefined holes', async () => {
    let resolveSecond: ((rows: Row[]) => void) | null = null;
    const transport = createMockTransport({
      query: async <TData,>() => {
        if (resolveSecond === null) {
          resolveSecond = () => {};
          return {
            data: {
              rows: [
                { id: 'row-1', label: 'first' },
                { id: 'row-2', label: 'second' }
              ]
            } as TData
          };
        }
        return await new Promise<{ data: TData }>(resolve => {
          resolveSecond = rows => resolve({ data: { rows } as TData });
        });
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('ReadCompaction');
    const query = defineQuery<{ rows: Row[] }, Record<string, never>, Record<string, never>, Row>({
      document: namedDocument,
      key: 'query-read-compaction',
      into: rows,
      select: data => data.rows
    });
    await query.fetch({});

    // The loss court defers a chain with an in-flight fetch, so the stale id stays in the chain
    // until that fetch settles; the imperative read still may not hand out undefined holes.
    const second = query.refresh({});
    rows.destroy('row-1');
    expect(query.read({})).toEqual([{ id: 'row-2', label: 'second' }]);

    resolveSecond!([{ id: 'row-2', label: 'second' }]);
    await second;
  });

  it('skips transport when the definition-level enabled predicate rejects the scope', async () => {
    let queryCalls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        queryCalls += 1;
        return { data: { rows: [] } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('DisabledFetch');
    const query = defineQuery<{ rows: Row[] }, { enabled: boolean }, { enabled: boolean }, Row>({
      document: namedDocument,
      key: 'query-disabled-fetch',
      into: rows,
      enabled: scope => scope.enabled,
      select: data => data.rows
    });

    await query.fetch({ enabled: false });

    expect(queryCalls).toBe(0);
  });
});
