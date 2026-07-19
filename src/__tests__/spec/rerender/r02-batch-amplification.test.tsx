import { act } from 'react-test-renderer';
import { configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime } from '../helpers/harness';

type BulkRow = { id: string; name: string; status: string; score: number };

type QueryPayload = {
  feed: {
    nodes: Array<BulkRow>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type DeferredCommitResult = { rename: BulkRow };

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
