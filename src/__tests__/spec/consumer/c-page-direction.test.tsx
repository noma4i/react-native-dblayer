import { act } from 'react';
import { configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCountedInProvider, settle } from '../helpers/harness';

type Row = { id: string; bucket: string; label: string };
type PageInfo = { hasNextPage?: boolean; endCursor?: string | null; hasPreviousPage?: boolean; startCursor?: string | null };
type PageResponse = { page: { nodes: Row[]; pageInfo?: PageInfo } };

const document = { kind: 'Document', definitions: [] } as never;

/**
 * Pagination direction decides WHICH pageInfo fields a chain reads. A forward chain advances on
 * `hasNextPage`/`endCursor`; a backward chain advances on `hasPreviousPage`/`startCursor`. Fields of
 * the other direction are not a fallback: reading them would advance a chain the server declared
 * exhausted, and a missing field means exhaustion, never availability.
 */
describe('page metadata follows the declared direction', () => {
  let suffix = 0;
  const setup = (direction: 'forward' | 'backward', pageInfo: PageInfo | undefined) => {
    const calls: Array<Record<string, unknown>> = [];
    let served = 0;
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        calls.push((operation.variables ?? {}) as Record<string, unknown>);
        served += 1;
        return { data: { page: { nodes: [{ id: `row-${served}`, bucket: 'main', label: `page-${served}` }], ...(pageInfo ? { pageInfo } : {}) } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const modelId = `SpecPageDirection${++suffix}`;
    const rows = defineModelRuntime({
      id: modelId,
      name: modelId,
      fields: { bucket: f.str(), label: f.str() },
      scopes: { bucket: ({ by: { bucket: 'bucket' }, sort: 'server-order' }) }
    });
    const query = rows.query<PageResponse, { bucket: string }, { bucket: string }, Row>('bucket', {
      document,
      vars: scope => ({ bucket: scope.bucket }),
      page: data => data.page,
      into: rows.scopes.bucket,
      direction,
      coverage: 'page'
    });
    return { calls, query };
  };

  it('advances a forward chain on hasNextPage and sends endCursor as the after variable', async () => {
    const { calls, query } = setup('forward', { hasNextPage: true, endCursor: 'forward-cursor' });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();

    expect(reader.result().hasNextPage).toBe(true);
    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ bucket: 'main', after: 'forward-cursor' });
    reader.unmount();
  });

  it('advances a backward chain on hasPreviousPage and sends startCursor as the before variable', async () => {
    const { calls, query } = setup('backward', { hasPreviousPage: true, startCursor: 'backward-cursor' });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();

    expect(reader.result().hasNextPage).toBe(true);
    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ bucket: 'main', before: 'backward-cursor' });
    reader.unmount();
  });

  it('treats forward metadata as exhaustion for a backward chain', async () => {
    const { calls, query } = setup('backward', { hasNextPage: true, endCursor: 'forward-cursor' });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();

    expect(reader.result().hasNextPage).toBe(false);
    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(calls).toHaveLength(1);
    reader.unmount();
  });

  it('treats backward metadata as exhaustion for a forward chain', async () => {
    const { calls, query } = setup('forward', { hasPreviousPage: true, startCursor: 'backward-cursor' });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();

    expect(reader.result().hasNextPage).toBe(false);
    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(calls).toHaveLength(1);
    reader.unmount();
  });

  it('[F58] a next-page request against an exhausted chain is a no-op: no landing, chain and scope rows intact', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const responses = [
      { nodes: [{ id: 'row-1', bucket: 'main', label: 'page-1' }], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
      { nodes: [{ id: 'row-2', bucket: 'main', label: 'page-2' }], pageInfo: { hasNextPage: false, endCursor: null } }
    ];
    let served = 0;
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        calls.push((operation.variables ?? {}) as Record<string, unknown>);
        const response = responses[Math.min(served, responses.length - 1)]!;
        served += 1;
        return { data: { page: response } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const modelId = `SpecPageDirection${++suffix}`;
    const rows = defineModelRuntime({
      id: modelId,
      name: modelId,
      fields: { bucket: f.str(), label: f.str() },
      scopes: { bucket: ({ by: { bucket: 'bucket' }, sort: 'server-order' }) }
    });
    const query = rows.query<PageResponse, { bucket: string }, { bucket: string }, Row>('bucket', {
      document,
      vars: scope => ({ bucket: scope.bucket }),
      page: data => data.page,
      into: rows.scopes.bucket,
      coverage: 'page'
    });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();
    // The render snapshot taken before the last page landed still says hasNextPage.
    const beforeLastPage = reader.result();
    expect(beforeLastPage.hasNextPage).toBe(true);
    await act(async () => {
      beforeLastPage.fetchNextPage();
      await settle();
    });
    expect(reader.result().hasNextPage).toBe(false);
    expect(reader.result().data.map(row => row.id)).toEqual(['row-1', 'row-2']);

    await act(async () => {
      beforeLastPage.fetchNextPage();
      await settle();
    });

    expect(calls).toHaveLength(2);
    expect(reader.result().data.map(row => row.id)).toEqual(['row-1', 'row-2']);
    expect(reader.result().hasNextPage).toBe(false);
    expect(reader.result().isFetchingNextPage).toBe(false);
    reader.unmount();
  });
});

/**
 * A malformed connection response cannot move the chain: a page without applicable pageInfo, a page
 * claiming a next page without a cursor, and a nullish payload are landing errors. The accumulated
 * chain and its memberships stay intact and the failure is reported, never silent exhaustion.
 */
describe('malformed connection landings', () => {
  let suffix = 0;
  const setupChain = (secondPage: { nodes: Row[]; pageInfo?: PageInfo } | null) => {
    const onSyncError = jest.fn();
    const calls: Array<Record<string, unknown>> = [];
    const responses: Array<{ nodes: Row[]; pageInfo?: PageInfo } | null> = [
      { nodes: [{ id: 'row-1', bucket: 'main', label: 'page-1' }], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
      secondPage,
      { nodes: [{ id: 'row-3', bucket: 'main', label: 'page-3' }], pageInfo: { hasNextPage: false, endCursor: null } }
    ];
    let served = 0;
    const transport = createMockTransport({
      query: async <TData, TVariables>(operation: { variables?: TVariables }) => {
        calls.push((operation.variables ?? {}) as Record<string, unknown>);
        const response = responses[Math.min(served, responses.length - 1)]!;
        served += 1;
        return { data: { page: response } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { onSyncError } });
    const modelId = `SpecMalformedLanding${++suffix}`;
    const rows = defineModelRuntime({
      id: modelId,
      name: modelId,
      fields: { bucket: f.str(), label: f.str() },
      scopes: { bucket: ({ by: { bucket: 'bucket' }, sort: 'server-order' }) }
    });
    const query = rows.query<{ page: { nodes: Row[]; pageInfo?: PageInfo } | null }, { bucket: string }, { bucket: string }, Row>('bucket', {
      document,
      vars: scope => ({ bucket: scope.bucket }),
      page: data => data.page as { nodes: Row[]; pageInfo?: PageInfo },
      into: rows.scopes.bucket,
      direction: 'forward',
      coverage: 'page'
    });
    return { calls, query, onSyncError };
  };

  it('[F44] keeps the accumulated chain when a next page lands without usable pageInfo', async () => {
    const { calls, query, onSyncError } = setupChain({ nodes: [{ id: 'row-2', bucket: 'main', label: 'page-2' }] });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();
    expect((reader.result().data as Row[]).map(row => row.id)).toEqual(['row-1']);

    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(onSyncError.mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining('pageInfo') });
    expect((reader.result().data as Row[]).map(row => row.id)).toEqual(['row-1']);
    expect(reader.result().hasNextPage).toBe(true);

    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(calls[2]).toEqual({ bucket: 'main', after: 'cursor-1' });
    expect((reader.result().data as Row[]).map(row => row.id)).toEqual(['row-1', 'row-3']);
    reader.unmount();
  });

  it('[F44] keeps the accumulated chain when a next page claims hasNextPage without a cursor', async () => {
    const { query, onSyncError } = setupChain({
      nodes: [{ id: 'row-2', bucket: 'main', label: 'page-2' }],
      pageInfo: { hasNextPage: true, endCursor: null }
    });
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();

    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect(onSyncError.mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining('cursor') });
    expect((reader.result().data as Row[]).map(row => row.id)).toEqual(['row-1']);
    expect(reader.result().hasNextPage).toBe(true);
    reader.unmount();
  });

  it('[F44] keeps the accumulated chain when a next page lands as a nullish payload', async () => {
    const { query, onSyncError } = setupChain(null);
    const reader = renderCountedInProvider(() => query.use({ bucket: 'main' }));
    await settle();

    await act(async () => {
      reader.result().fetchNextPage();
      await settle();
    });

    expect(onSyncError).toHaveBeenCalledTimes(1);
    expect((reader.result().data as Row[]).map(row => row.id)).toEqual(['row-1']);
    expect(reader.result().hasNextPage).toBe(true);
    reader.unmount();
  });
});
