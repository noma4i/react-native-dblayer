import { act } from 'react-test-renderer';
import { configureDb, defineModel, defineShape, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime } from '../helpers/harness';

type BulkRow = { id: string; name: string; status: string; score: number };

type QueryPayload = {
  feed: {
    nodes: Array<BulkRow>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type DeferredCommitResult = { rename: BulkRow };

type NestedBulkRow = BulkRow & { markers: Array<{ id: string; label: string }> };

type NestedQueryPayload = {
  feed: {
    nodes: NestedBulkRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const markerShape = defineShape<{ id: string; label: string }>()({
  id: f.id(),
  label: f.str()
});

const createSimpleModel = () =>
  defineModel({
    id: 'SpecRerenderBatchSimple',
    name: 'SpecRerenderBatchSimple',
    fields: {
      name: f.str(),
      status: f.str(),
      score: f.num()
    }
  });

const createScopedModel = () =>
  defineModel({
    id: 'SpecRerenderBatchScoped',
    name: 'SpecRerenderBatchScoped',
    fields: {
      name: f.str(),
      status: f.str(),
      score: f.num()
    },
    scopes: {
      byStatus: scope<BulkRow>({ by: { status: 'status' } })
    }
  });

const createNestedScopedModel = () =>
  defineModel({
    id: 'SpecRerenderBatchNested',
    name: 'SpecRerenderBatchNested',
    fields: {
      name: f.str(),
      status: f.str(),
      score: f.num(),
      markers: f.array(markerShape)
    },
    scopes: {
      byStatus: scope<NestedBulkRow>({ by: { status: 'status' } })
    }
  });

const deferredMutation = () => {
  let resolve!: (value: DeferredCommitResult) => void;
  const promise = new Promise<DeferredCommitResult>((nextResolve, _nextReject) => {
    resolve = nextResolve;
  });

  const transport = createMockTransport({
    mutation: async <TData,>() => ({
      data: (await promise) as TData
    })
  });

  return { transport, resolve, promise };
};

const scopedModelQueryTransport = () =>
  createMockTransport({
    query: async <TData,>() => {
      const payload: QueryPayload = {
        feed: {
          nodes: Array.from({ length: 10 }, (_, index) => ({
            id: String(index),
            name: `page-${index}`,
            status: 'a',
            score: index
          })),
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      };
      return { data: payload as TData };
    }
  });

describe('rerender matrix batch amplification', () => {
  it('keeps row, scope, and view readers stable when an identical query page is normalized again', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => {
        const payload: NestedQueryPayload = {
          feed: {
            nodes: Array.from({ length: 10 }, (_, index) => ({
              id: String(index),
              name: `page-${index}`,
              status: 'a',
              score: index,
              markers: [{ id: `marker-${index}`, label: `Marker ${index}` }]
            })),
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        };
        return { data: payload as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createNestedScopedModel();
    const query = rows.query<NestedQueryPayload, { status: string }, { status: string }, NestedBulkRow>('identical-page', {
      document: { kind: 'Document', definitions: [] } as never,
      vars: scopeValue => scopeValue,
      page: payload => ({ nodes: payload.feed.nodes, pageInfo: payload.feed.pageInfo }),
      into: rows.scopes.byStatus,
      coverage: 'page'
    });
    const view = rows.view<{ value: NestedBulkRow }>('identical-page', {
      source: rows.scopes.byStatus,
      include: {},
      select: row => ({ value: row }),
      renderKeys: ['value']
    });

    await act(async () => {
      await query.fetch({ status: 'a' });
    });
    const rowReader = renderCounted(() => rows.use.row('0'));
    const scopeReader = renderCounted(() => rows.scopes.byStatus.use({ status: 'a' }));
    const viewReader = renderCounted(() => view.use({ status: 'a' }));
    const beforeRow = rowReader.result();
    const beforeScope = scopeReader.result();
    const beforeView = viewReader.result();
    const beforeStoredRows = new Map(rows.getAll().map(row => [row.id, row]));
    const beforeRenders = [rowReader.renders(), scopeReader.renders(), viewReader.renders()];

    await act(async () => {
      await query.fetch({ status: 'a' });
    });

    expect(rowReader.result()).toBe(beforeRow);
    expect(scopeReader.result()).toBe(beforeScope);
    expect(viewReader.result()).toBe(beforeView);
    expect(rows.getAll().every(row => beforeStoredRows.get(row.id) === row)).toBe(true);
    expect([rowReader.renders(), scopeReader.renders(), viewReader.renders()].map((count, index) => count - beforeRenders[index]!)).toEqual([0, 0, 0]);
    rowReader.unmount();
    scopeReader.unmount();
    viewReader.unmount();
  });

  it('does not notify readers when a patch nets zero field changes', () => {
    setupSpecRuntime();
    const rows = createNestedScopedModel();
    rows.insertStored({ id: '1', name: 'same', status: 'a', score: 1, markers: [{ id: 'marker-1', label: 'Marker 1' }] });
    const rowReader = renderCounted(() => rows.use.row('1'));
    const scopeReader = renderCounted(() => rows.scopes.byStatus.use({ status: 'a' }));
    const beforeRow = rowReader.result();
    const beforeScope = scopeReader.result();
    const beforeRenders = [rowReader.renders(), scopeReader.renders()];

    act(() => {
      rows.patch('1', { markers: [{ id: 'marker-1', label: 'Marker 1' }] });
    });

    expect(rowReader.result()).toBe(beforeRow);
    expect(scopeReader.result()).toBe(beforeScope);
    expect([rowReader.renders(), scopeReader.renders()].map((count, index) => count - beforeRenders[index]!)).toEqual([0, 0]);
    rowReader.unmount();
    scopeReader.unmount();
  });

  it('notifies only affected readers once for one real field change', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    rows.insertStoredMany([
      { id: '1', name: 'first', status: 'a', score: 1 },
      { id: '2', name: 'second', status: 'b', score: 2 }
    ]);
    const changedRowReader = renderCounted(() => rows.use.row('1'));
    const untouchedRowReader = renderCounted(() => rows.use.row('2'));
    const affectedScopeReader = renderCounted(() => rows.scopes.byStatus.use({ status: 'a' }));
    const untouchedScopeReader = renderCounted(() => rows.scopes.byStatus.use({ status: 'b' }));
    const beforeRenders = [changedRowReader.renders(), untouchedRowReader.renders(), affectedScopeReader.renders(), untouchedScopeReader.renders()];

    act(() => {
      rows.patch('1', { name: 'updated' });
    });

    expect(
      [changedRowReader.renders(), untouchedRowReader.renders(), affectedScopeReader.renders(), untouchedScopeReader.renders()].map(
        (count, index) => count - beforeRenders[index]!
      )
    ).toEqual([1, 0, 1, 0]);
    changedRowReader.unmount();
    untouchedRowReader.unmount();
    affectedScopeReader.unmount();
    untouchedScopeReader.unmount();
  });

  it('applies one query page payload to scope reader in one wave', async () => {
    const transport = scopedModelQueryTransport();
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createScopedModel();
    const query = rows.query<QueryPayload, { status: string }, { status: string }, BulkRow>('batch-page', {
      document: { kind: 'Document', definitions: [] } as never,
      vars: scopeValue => scopeValue,
      page: payload => ({ nodes: payload.feed.nodes, pageInfo: payload.feed.pageInfo }),
      into: rows.scopes.byStatus,
      coverage: 'page'
    });

    const scopeReader = renderCounted(() => rows.scopes.byStatus.use({ status: 'a' }));
    const before = scopeReader.renders();

    await act(async () => {
      await query.fetch({ status: 'a' });
    });

    expect(scopeReader.renders() - before).toBe(1);
    scopeReader.unmount();
  });

  it('keeps a row patch to one id local to one row reader', () => {
    setupSpecRuntime();
    const rows = createSimpleModel();
    rows.insertStoredMany(
      Array.from({ length: 50 }, (_, index) => ({ id: String(index), name: `row-${index}`, status: index % 2 === 0 ? 'a' : 'b', score: index })) as BulkRow[]
    );

    const readers = Array.from({ length: 50 }, (_, index) => renderCounted(() => rows.use.row(String(index))));
    const before = readers.map(reader => reader.renders());

    act(() => {
      rows.patch('25', { score: 999 });
    });

    const after = readers.map(reader => reader.renders());
    const deltas = after.map((next, index) => next - before[index]);

    expect(deltas.reduce((total, delta) => total + delta, 0)).toBe(1);
    expect(deltas[25]).toBe(1);
    readers.forEach(reader => reader.unmount());
  });

  it('keeps insertStoredMany wave narrow with untouched row readers stable', () => {
    setupSpecRuntime();
    const rows = createScopedModel();
    rows.insertStoredMany(
      Array.from({ length: 20 }, (_, index) => ({ id: String(index), name: `seed-${index}`, status: 'active', score: index })) as BulkRow[]
    );

    const scopeReader = renderCounted(() => rows.scopes.byStatus.use({ status: 'active' }));
    const untouchedReaders = Array.from({ length: 20 }, (_, index) => renderCounted(() => rows.use.row(String(index))));
    const scopeBefore = scopeReader.renders();
    const untouchedBefore = untouchedReaders.map(reader => reader.renders());

    act(() => {
      rows.insertStoredMany(
        Array.from({ length: 20 }, (_, index) => ({
          id: String(index + 20),
          name: `burst-${index + 20}`,
          status: 'active',
          score: index + 20
        })) as BulkRow[]
      );
    });

    const scopeAfter = scopeReader.renders();
    const untouchedAfter = untouchedReaders.map(reader => reader.renders());
    const untouchedDeltas = untouchedAfter.map((next, index) => next - untouchedBefore[index]);

    expect(scopeAfter - scopeBefore).toBe(1);
    expect(untouchedDeltas.reduce((total, delta) => total + delta, 0)).toBe(0);
    untouchedReaders.forEach(reader => reader.unmount());
    scopeReader.unmount();
  });

  it('keeps commit and ingest updates inside one observed wave budget', async () => {
    const deferred = deferredMutation();
    const { transport, resolve, promise } = deferred;
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createSimpleModel();
    rows.insertStored({ id: '1', name: 'seed-1', status: 'a', score: 1 });

    const mutation = rows.mutation<{ rename: BulkRow }, { id: string; name: string }, BulkRow, BulkRow>('rename', {
      document: { kind: 'Document', definitions: [] } as never,
      result: 'rename',
      optimistic: {
        method: 'patch',
        model: rows,
        selectId: input => input.id,
        selectPatch: input => ({ name: input.name })
      },
      extract: ({ data }) => [{ into: rows, rows: [data.rename] }]
    });

    const ingest = rows.ingest({
      committed: {
        handler: payload => ({ upsert: payload as BulkRow })
      }
    });

    const reader = renderCounted(() => rows.use.row('1'));
    const before = reader.renders();
    let committed!: Promise<{ rename: BulkRow } | null>;

    act(() => {
      committed = mutation.run({ id: '1', name: 'from-commit' });
      ingest.apply('committed', { id: '1', name: 'from-ingest', status: 'a', score: 1 });
      resolve({ rename: { id: '1', name: 'from-commit', status: 'a', score: 1 } });
    });

    const afterKick = reader.renders();
    const observedWaves = 3;
    expect(afterKick - before).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await committed;
      await promise;
    });

    const afterCommit = reader.renders();
    expect(afterCommit - before).toBeLessThanOrEqual(observedWaves);
    reader.unmount();
  });
});
