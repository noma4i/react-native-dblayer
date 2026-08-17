import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, defineModelRuntime, defineShape, f, useLoadMore, useRelationLoadMore } from '../../testApi';
import type { LoadMoreOptions, QueryResult, RelationResult } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, renderCountedInProvider, settle } from '../helpers/harness';

type BucketRow = { id: string; bucket: string; label: string };
type PageResponse = { page: { nodes: BucketRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type CallEntry = { kind: 'query'; operation: { variables: { bucket: string; after?: string } } };

const document = { kind: 'Document', definitions: [] } as never;

const bucketPage = (nodes: BucketRow[], hasNextPage: boolean, endCursor: string | null): PageResponse => ({
  page: { nodes, pageInfo: { hasNextPage, endCursor } }
});

const createBucketModel = (suffix: string) =>
  defineModelRuntime({
    id: `SpecLoadMore${suffix}`,
    name: `SpecLoadMore${suffix}`,
    fields: { bucket: f.str(), label: f.str() },
    scopes: { bucket: ({ by: { bucket: 'bucket' }, sort: 'server-order' }) }
  });

const createBucketQuery = (rows: ReturnType<typeof createBucketModel>) =>
  rows.query<PageResponse, { bucket: string }, { bucket: string }, BucketRow>('bucket', {
    document,
    vars: scope => ({ bucket: scope.bucket }),
    page: data => data.page,
    into: rows.scopes.bucket,
    coverage: 'page'
  });

type QueryProbeValue = { result: QueryResult<unknown>; loadMore: () => void };

const renderQueryLoadMore = (query: ReturnType<typeof createBucketQuery>, initial: LoadMoreOptions) => {
  let latest!: QueryProbeValue;
  let root!: TestRenderer.ReactTestRenderer;
  const Probe = ({ options }: { options: LoadMoreOptions }) => {
    const result = query.use({ bucket: 'main' }) as QueryResult<unknown>;
    latest = { result, loadMore: useLoadMore(result, options) };
    return null;
  };
  const mount = (options: LoadMoreOptions) => React.createElement(DbProvider, null, React.createElement(Probe, { options }));
  act(() => {
    root = TestRenderer.create(mount(initial));
  });
  return {
    result: () => latest,
    update: (options: LoadMoreOptions) => act(() => root.update(mount(options))),
    unmount: () => act(() => root.unmount())
  };
};

type Row = { id: string };
describe('useLoadMore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('collapses a burst of calls into one trailing advance', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const rows = defineModel('SpecLoadMoreBurst', {
      schema: defineShape<BucketRow>()({ bucket: f.str(), label: f.str() }),
      relations: _owner => ({ page: { by: { bucket: 'bucket' }, sort: { field: 'label', dir: 'asc' } } })
    });
    rows.insertMany([
      { id: 'r-1', bucket: 'main', label: 'a' },
      { id: 'r-2', bucket: 'main', label: 'b' },
      { id: 'r-3', bucket: 'main', label: 'c' },
      { id: 'r-4', bucket: 'main', label: 'd' }
    ]);
    const relation = rows.page({ bucket: 'main' });
    const reader = renderCounted(() => {
      const result = relation.use({ pageSize: 1 }) as RelationResult<Row[]>;
      return { result, loadMore: useLoadMore(result, { debounceMs: 5 }) };
    });
    expect(reader.result().result.data.map(row => row.id)).toEqual(['r-1']);

    act(() => {
      reader.result().loadMore();
      reader.result().loadMore();
      reader.result().loadMore();
    });
    act(() => jest.advanceTimersByTime(200));

    // Three end-reached events in one burst reveal exactly one page, not three.
    expect(reader.result().result.data.map(row => row.id)).toEqual(['r-1', 'r-2']);

    // A later burst advances again by exactly one page.
    act(() => {
      reader.result().loadMore();
      reader.result().loadMore();
    });
    act(() => jest.advanceTimersByTime(200));
    expect(reader.result().result.data.map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
    reader.unmount();
  });

  it('guards at fire time by hasNextPage and isFetchingNextPage read from the LATEST render', async () => {
    let resolveSecond!: (value: { data: PageResponse }) => void;
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        if (served === 1) return { data: bucketPage([{ id: 'row-1', bucket: 'main', label: 'page-1' }], true, 'cursor-1') as TData };
        return new Promise<{ data: TData }>(resolve => {
          resolveSecond = resolve as never;
        });
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketModel('Guard');
    const query = createBucketQuery(rows);
    const reader = renderCountedInProvider(() => {
      const result = query.use({ bucket: 'main' });
      return { result, loadMore: useLoadMore(result, { debounceMs: 5 }) };
    });
    await settle();
    expect((reader.result().result.data as BucketRow[]).map(row => row.id)).toEqual(['row-1']);
    expect(reader.result().result.hasNextPage).toBe(true);

    // Guards pass: the debounced advance sends exactly the cursor request.
    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[1] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-1' });
    expect(reader.result().result.isFetchingNextPage).toBe(true);

    // isFetchingNextPage guard: an advance fired while page 2 is in flight must not cancel and re-send it.
    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(transport.calls).toHaveLength(2);

    // hasNextPage is read from the LATEST render: exhaustion lands between schedule and fire.
    act(() => {
      reader.result().loadMore();
      resolveSecond({ data: bucketPage([{ id: 'row-2', bucket: 'main', label: 'page-2' }], false, null) });
    });
    await settle();
    expect(reader.result().result.hasNextPage).toBe(false);
    expect((reader.result().result.data as BucketRow[]).map(row => row.id)).toEqual(['row-1', 'row-2']);
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect(reader.result().result.isFetchingNextPage).toBe(false);
    reader.unmount();
  });

  it('suppresses the page request while enabled is false and sends it once re-enabled', async () => {
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return { data: bucketPage([{ id: `row-${served}`, bucket: 'main', label: `page-${served}` }], true, `cursor-${served}`) as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketModel('Enabled');
    const query = createBucketQuery(rows);
    const probe = renderQueryLoadMore(query, { debounceMs: 5, enabled: false });
    await settle();
    expect(rows.scopes.bucket.read({ bucket: 'main' }).map(row => row.id)).toEqual(['row-1']);

    act(() => probe.result().loadMore());
    act(() => jest.advanceTimersByTime(200));
    await settle();
    expect(transport.calls).toHaveLength(1);
    expect(rows.scopes.bucket.read({ bucket: 'main' }).map(row => row.id)).toEqual(['row-1']);

    probe.update({ debounceMs: 5, enabled: true });
    act(() => probe.result().loadMore());
    act(() => jest.advanceTimersByTime(200));
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[1] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-1' });
    expect(rows.scopes.bucket.read({ bucket: 'main' }).map(row => row.id)).toEqual(['row-1', 'row-2']);
    probe.unmount();
  });

  it('cancels a pending advance on unmount', async () => {
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        return { data: bucketPage([{ id: `row-${served}`, bucket: 'main', label: `page-${served}` }], true, `cursor-${served}`) as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketModel('UnmountCancel');
    const query = createBucketQuery(rows);
    const reader = renderCountedInProvider(() => {
      const result = query.use({ bucket: 'main' });
      return { result, loadMore: useLoadMore(result, { debounceMs: 5 }) };
    });
    await settle();
    expect(transport.calls).toHaveLength(1);

    // Mounted counterpart: the same scheduled advance sends the cursor request when left to fire.
    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[1] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-1' });
    expect((reader.result().result.data as BucketRow[]).map(row => row.id)).toEqual(['row-1', 'row-2']);
    expect(reader.result().result.hasNextPage).toBe(true);

    // Unmount between schedule and fire: no request leaves and the landed rows stay at 2.
    act(() => reader.result().loadMore());
    reader.unmount();
    act(() => jest.advanceTimersByTime(500));
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect(rows.scopes.bucket.read({ bucket: 'main' }).map(row => row.id)).toEqual(['row-1', 'row-2']);
  });

  it('advances a relation result without an app-side pagination adapter', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport({}) });
    const rows = defineModel('SpecLoadMoreRelationTarget', {
      schema: defineShape<BucketRow>()({ bucket: f.str(), label: f.str() }),
      relations: _owner => ({ page: { by: { bucket: 'bucket' }, sort: { field: 'label', dir: 'asc' } } })
    });
    rows.insertMany([
      { id: 'r-1', bucket: 'main', label: 'a' },
      { id: 'r-2', bucket: 'main', label: 'b' },
      { id: 'r-3', bucket: 'main', label: 'c' }
    ]);
    const relation = rows.page({ bucket: 'main' });
    const reader = renderCounted(() => {
      const result = relation.use({ pageSize: 1 }) as RelationResult<Row[]>;
      return { result, loadMore: useLoadMore(result, { debounceMs: 1 }) };
    });
    expect(reader.result().result.data.map(row => row.id)).toEqual(['r-1']);
    expect(reader.result().result.hasMore).toBe(true);

    act(() => {
      reader.result().loadMore();
      jest.advanceTimersByTime(1);
    });
    expect(reader.result().result.data.map(row => row.id)).toEqual(['r-1', 'r-2']);

    act(() => {
      reader.result().loadMore();
      jest.advanceTimersByTime(1);
    });
    expect(reader.result().result.data.map(row => row.id)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(reader.result().result.hasMore).toBe(false);
    reader.unmount();
  });
});

describe('useRelationLoadMore', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reveals a local page without starting a network request', async () => {
    const transport = createMockTransport({
      query: async <TData,>() =>
        ({
          data: bucketPage(
            [
              { id: 'm3', bucket: 'main', label: 'page-1' },
              { id: 'm2', bucket: 'main', label: 'page-1' },
              { id: 'm1', bucket: 'main', label: 'page-1' }
            ],
            true,
            'cursor-1'
          ) as TData
        })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketModel('LocalReveal');
    const query = createBucketQuery(rows);
    const reader = renderCountedInProvider(() => {
      const window = rows.scopes.bucket.useWindow({ bucket: 'main' }, { pageSize: 2 });
      const result = query.use({ bucket: 'main' });
      return { window, loadMore: useRelationLoadMore(window, result, { debounceMs: 1 }) };
    });
    await settle();
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m3', 'm2']);
    expect(reader.result().window.hasMore).toBe(true);
    expect(transport.calls).toHaveLength(1);

    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(1));
    await settle();

    // The local page is revealed and no second page request was sent.
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m3', 'm2', 'm1']);
    expect(transport.calls).toHaveLength(1);
    reader.unmount();
  });

  it('fetches the server page and reveals it after the local total grows', async () => {
    const responses: PageResponse[] = [
      bucketPage(
        [
          { id: 'm3', bucket: 'main', label: 'page-1' },
          { id: 'm2', bucket: 'main', label: 'page-1' }
        ],
        true,
        'cursor-1'
      ),
      bucketPage([{ id: 'm1', bucket: 'main', label: 'page-2' }], false, null)
    ];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected query response');
        return { data: next as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketModel('ServerReveal');
    const query = createBucketQuery(rows);
    const reader = renderCountedInProvider(() => {
      const window = rows.scopes.bucket.useWindow({ bucket: 'main' }, { pageSize: 4 });
      const result = query.use({ bucket: 'main' });
      return { window, loadMore: useRelationLoadMore(window, result, { debounceMs: 1 }) };
    });
    await settle();
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m3', 'm2']);
    expect(reader.result().window.hasMore).toBe(false);

    // Nothing local remains, so the advance goes to the network with the cursor of the last page.
    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(1));
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[1] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-1' });

    // The landed row grows the total and is revealed inside the same window.
    expect(reader.result().window.totalCount).toBe(3);
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m3', 'm2', 'm1']);
    reader.unmount();
  });

  it('does not reveal after an unchanged total or when no local page remains, yet reveals a remaining local page', async () => {
    const responses: PageResponse[] = [
      bucketPage(
        [
          { id: 'm106', bucket: 'main', label: 'page-1' },
          { id: 'm105', bucket: 'main', label: 'page-1' },
          { id: 'm104', bucket: 'main', label: 'page-1' }
        ],
        true,
        'cursor-104'
      ),
      // A duplicate landing: the server re-sends m104, so the scope total does not grow.
      bucketPage([{ id: 'm104', bucket: 'main', label: 'page-2' }], true, 'cursor-104b'),
      bucketPage([{ id: 'm103', bucket: 'main', label: 'page-3' }], true, 'cursor-103')
    ];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected query response');
        return { data: next as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBucketModel('RevealGuards');
    const query = createBucketQuery(rows);
    const reader = renderCountedInProvider(() => {
      const window = rows.scopes.bucket.useWindow({ bucket: 'main' }, { pageSize: 4 });
      const result = query.use({ bucket: 'main' });
      return { window, loadMore: useRelationLoadMore(window, result, { debounceMs: 5 }) };
    });
    await settle();
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m106', 'm105', 'm104']);
    expect(reader.result().window.hasMore).toBe(false);

    // Advance with no local page: the server is asked, the total stays at 3, nothing is revealed.
    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[1] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-104' });
    expect(reader.result().window.totalCount).toBe(3);
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m106', 'm105', 'm104']);

    // Advance again: the total grows to 4 but the window already shows all 4, so no reveal happens.
    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(transport.calls).toHaveLength(3);
    expect((transport.calls[2] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-104b' });
    expect(reader.result().window.totalCount).toBe(4);
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m106', 'm105', 'm104', 'm103']);

    // If either guarded branch had revealed, the window limit would now exceed 4 and show 6 rows.
    act(() => {
      rows.insert({ id: 'm102', bucket: 'main', label: 'local' });
      rows.insert({ id: 'm101', bucket: 'main', label: 'local' });
    });
    await settle();
    expect(reader.result().window.totalCount).toBe(6);
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m106', 'm105', 'm104', 'm103']);
    expect(reader.result().window.hasMore).toBe(true);

    // Positive counterpart: with a local page remaining the same advance reveals it without transport.
    act(() => reader.result().loadMore());
    act(() => jest.advanceTimersByTime(5));
    await settle();
    expect(transport.calls).toHaveLength(3);
    expect(reader.result().window.rows.map(row => row.id)).toEqual(['m106', 'm105', 'm104', 'm103', 'm102', 'm101']);
    reader.unmount();
  });
});
