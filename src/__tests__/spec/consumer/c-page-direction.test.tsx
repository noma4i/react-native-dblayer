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

  it('treats an absent pageInfo as exhaustion in both directions', async () => {
    const forward = setup('forward', undefined);
    const forwardReader = renderCountedInProvider(() => forward.query.use({ bucket: 'main' }));
    await settle();
    expect(forwardReader.result().hasNextPage).toBe(false);
    forwardReader.unmount();

    const backward = setup('backward', undefined);
    const backwardReader = renderCountedInProvider(() => backward.query.use({ bucket: 'main' }));
    await settle();
    expect(backwardReader.result().hasNextPage).toBe(false);
    backwardReader.unmount();
  });
});
