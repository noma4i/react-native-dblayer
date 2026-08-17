import { act } from 'react';
import { bridgeWindowPagination, configureDb, defineModelRuntime, f, type ScopeWindowResult } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCountedInProvider, settle } from '../helpers/harness';

// Window-first pagination bridge, proven through the public `query.useWindow` surface.

type BucketRow = { id: string; bucket: string; label: string };
type PageResponse = { page: { nodes: BucketRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type CallEntry = { kind: 'query'; operation: { variables: { bucket: string; after?: string } } };

const document = { kind: 'Document', definitions: [] } as never;

const bucketPage = (nodes: BucketRow[], hasNextPage: boolean, endCursor: string | null): PageResponse => ({
  page: { nodes, pageInfo: { hasNextPage, endCursor } }
});

const createBridgeModel = (suffix: string) =>
  defineModelRuntime({
    id: `SpecPaginationBridge${suffix}`,
    name: `SpecPaginationBridge${suffix}`,
    fields: { bucket: f.str(), label: f.str() },
    scopes: { bucket: ({ by: { bucket: 'bucket' }, sort: 'server-order' }) }
  });

const createBridgeQuery = (rows: ReturnType<typeof createBridgeModel>) =>
  rows.query<PageResponse, { bucket: string }, { bucket: string }, BucketRow>('bucket', {
    document,
    vars: scope => ({ bucket: scope.bucket }),
    page: data => data.page,
    into: rows.scopes.bucket,
    coverage: 'page'
  });

const makeWindow = (overrides: Partial<ScopeWindowResult<{ id: string }>> = {}): ScopeWindowResult<{ id: string }> => ({
  rows: [{ id: 'r-1' }],
  totalCount: 1,
  hasMore: false,
  fetchNextPage: jest.fn(),
  isPreviousData: false,
  resolved: true,
  ...overrides
});

const makeQuery = (overrides: Partial<Parameters<typeof bridgeWindowPagination>[1]> = {}): Parameters<typeof bridgeWindowPagination>[1] => ({
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(),
  loadingState: { phase: 'ready' } as never,
  error: null,
  ...overrides
});

describe('bridgeWindowPagination', () => {
  it('reveals a synced local page without a network request while the window has more, then pages the network once exhausted', async () => {
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        if (served === 1) {
          return {
            data: bucketPage(
              [
                { id: 'm4', bucket: 'main', label: 'page-1' },
                { id: 'm3', bucket: 'main', label: 'page-1' },
                { id: 'm2', bucket: 'main', label: 'page-1' },
                { id: 'm1', bucket: 'main', label: 'page-1' }
              ],
              true,
              'cursor-1'
            ) as TData
          };
        }
        return { data: bucketPage([{ id: 'm0', bucket: 'main', label: 'page-2' }], false, null) as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBridgeModel('WindowFirst');
    const query = createBridgeQuery(rows);
    const reader = renderCountedInProvider(() => query.useWindow({ bucket: 'main' }, { pageSize: 2 }));
    await settle();
    expect(reader.result().rows.map(row => row.id)).toEqual(['m4', 'm3']);
    expect(reader.result().hasNextPage).toBe(true);
    expect(transport.calls).toHaveLength(1);

    // Local rows remain: the advance reveals them and no page request leaves.
    act(() => reader.result().fetchNextPage());
    expect(reader.result().rows.map(row => row.id)).toEqual(['m4', 'm3', 'm2', 'm1']);
    expect(transport.calls).toHaveLength(1);

    // Positive counterpart: the window is exhausted now, so the same advance sends the cursor request.
    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });
    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[1] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-1' });
    expect(reader.result().totalCount).toBe(5);
    expect(rows.scopes.bucket.read({ bucket: 'main' }).map(row => row.id)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
    reader.unmount();
  });

  it('falls through to the network page when the window starts exhausted and reveals the landed row', async () => {
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        served += 1;
        if (served === 1) {
          return {
            data: bucketPage(
              [
                { id: 'm3', bucket: 'main', label: 'page-1' },
                { id: 'm2', bucket: 'main', label: 'page-1' }
              ],
              true,
              'cursor-1'
            ) as TData
          };
        }
        return { data: bucketPage([{ id: 'm1', bucket: 'main', label: 'page-2' }], false, null) as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createBridgeModel('NetworkFallthrough');
    const query = createBridgeQuery(rows);
    const reader = renderCountedInProvider(() => query.useWindow({ bucket: 'main' }, { pageSize: 4 }));
    await settle();
    expect(reader.result().rows.map(row => row.id)).toEqual(['m3', 'm2']);
    expect(reader.result().hasNextPage).toBe(true);

    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });
    expect(transport.calls).toHaveLength(2);
    expect((transport.calls[1] as CallEntry).operation.variables).toEqual({ bucket: 'main', after: 'cursor-1' });
    expect(reader.result().rows.map(row => row.id)).toEqual(['m3', 'm2', 'm1']);
    expect(reader.result().hasNextPage).toBe(false);
    reader.unmount();
  });

  it('ORs hasNextPage across both sources', () => {
    expect(bridgeWindowPagination(makeWindow({ hasMore: true }), makeQuery({ hasNextPage: false })).hasNextPage).toBe(true);
    expect(bridgeWindowPagination(makeWindow({ hasMore: false }), makeQuery({ hasNextPage: true })).hasNextPage).toBe(true);
    expect(bridgeWindowPagination(makeWindow({ hasMore: false }), makeQuery({ hasNextPage: false })).hasNextPage).toBe(false);
  });

  it('passes window rows and query state through unchanged', () => {
    const window = makeWindow();
    const query = makeQuery({ error: new Error('boom'), isFetchingNextPage: true });
    const bridge = bridgeWindowPagination(window, query);
    expect(bridge.rows).toBe(window.rows);
    expect(bridge.totalCount).toBe(1);
    expect(bridge.resolved).toBe(true);
    expect(bridge.isFetchingNextPage).toBe(true);
    expect(bridge.error).toBe(query.error);
    expect(bridge.loadingState).toBe(query.loadingState);
  });
});
