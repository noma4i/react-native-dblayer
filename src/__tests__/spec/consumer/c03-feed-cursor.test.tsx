import { act } from 'react';
import { configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, settle, renderCountedInProvider } from '../helpers/harness';

// Mirrors yupi_v2 src/db/queries/useFeed.ts: server-order scope, cursor pagination keyed off the
// LAST row's sequenceNumber (getCursor + mapCursor Number), maxPages-bounded infinite query.

type FeedRow = { id: string; vibeId: string; sequenceNumber: number };
type FeedResponse = { feed: { nodes: FeedRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; lastSequenceNumber: number } };
type ScopeValue = { vibeId: string };
type CallEntry = { kind: 'query'; operation: { variables: { vibeId: string; afterSequence?: number } } };

const document = { kind: 'Document', definitions: [] } as never;

const createMoments = (suffix: string) =>
  defineModelRuntime({
    id: `SpecConsumerFeedCursor${suffix}`,
    name: `SpecConsumerFeedCursor${suffix}`,
    fields: { id: f.str(), vibeId: f.str(), sequenceNumber: f.num() },
    scopes: {
      feed: ({ by: { vibeId: 'vibeId' }, sort: 'server-order' })
    }
  });

describe('feed cursor pagination consumer contracts', () => {
  it('retains prior page identities in model destination query data', async () => {
    const responses: FeedResponse[] = [
      {
        feed: {
          nodes: [
            { id: 'm2', vibeId: 'v1', sequenceNumber: 102 },
            { id: 'm1', vibeId: 'v1', sequenceNumber: 101 }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
          lastSequenceNumber: 101
        }
      },
      {
        feed: {
          nodes: [{ id: 'm0', vibeId: 'v1', sequenceNumber: 100 }],
          pageInfo: { hasNextPage: false, endCursor: null },
          lastSequenceNumber: 100
        }
      }
    ];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected query response');
        return { data: next as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('ModelDestinationPages');
    const feedQuery = moments.query<FeedResponse, ScopeValue & { afterSequence?: number }, ScopeValue, FeedRow>('feed-model-destination', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments,
      getCursor: page => String((page as FeedResponse['feed']).lastSequenceNumber),
      cursorVar: 'afterSequence',
      mapCursor: cursor => Number(cursor)
    });
    const queryReader = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));

    await settle();
    await settle(1, { macro: true });
    expect((queryReader.result().data as FeedRow[]).map(row => row.id)).toEqual(['m2', 'm1']);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });

    expect((queryReader.result().data as FeedRow[]).map(row => row.id)).toEqual(['m2', 'm1', 'm0']);
    queryReader.unmount();
  });

  it('caps pagination at maxPages: hasNextPage turns false and no further request leaves', async () => {
    const pageAt = (sequence: number): FeedResponse => ({
      feed: {
        nodes: [{ id: `m${sequence}`, vibeId: 'v1', sequenceNumber: sequence }],
        pageInfo: { hasNextPage: true, endCursor: `cursor-${sequence}` },
        lastSequenceNumber: sequence
      }
    });
    let served = 0;
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: pageAt(200 - (served += 1)) as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('MaxPages');
    const feedQuery = moments.query<FeedResponse, ScopeValue & { afterSequence?: number }, ScopeValue, FeedRow>('feed-max-pages', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      coverage: 'page',
      maxPages: 2,
      getCursor: page => String((page as FeedResponse['feed']).lastSequenceNumber),
      cursorVar: 'afterSequence',
      mapCursor: cursor => Number(cursor)
    });

    const queryReader = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    expect(queryReader.result().hasNextPage).toBe(true);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });

    expect(queryReader.result().hasNextPage).toBe(false);
    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });

    expect(transport.calls).toHaveLength(2);
    queryReader.unmount();
  });

  it('fetches the next page with afterSequence derived from the last row of the previous page', async () => {
    const page1: FeedResponse = {
      feed: {
        nodes: [
          { id: 'm3', vibeId: 'v1', sequenceNumber: 103 },
          { id: 'm2', vibeId: 'v1', sequenceNumber: 102 },
          { id: 'm1', vibeId: 'v1', sequenceNumber: 101 }
        ],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-101' },
        lastSequenceNumber: 101
      }
    };
    const page2: FeedResponse = {
      feed: {
        nodes: [{ id: 'm0', vibeId: 'v1', sequenceNumber: 100 }],
        pageInfo: { hasNextPage: false, endCursor: null },
        lastSequenceNumber: 100
      }
    };
    const responses = [page1, page2];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected query response');
        return { data: next as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('AfterSequence');
    const feedQuery = moments.query<FeedResponse, ScopeValue & { afterSequence?: number }, ScopeValue, FeedRow>('feed', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      coverage: 'page',
      getCursor: page => String((page as FeedResponse['feed']).lastSequenceNumber),
      cursorVar: 'afterSequence',
      mapCursor: cursor => Number(cursor)
    });

    const queryReader = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });

    const calls = transport.calls as unknown as CallEntry[];
    expect(calls).toHaveLength(2);
    expect(calls[1]!.operation.variables.afterSequence).toBe(101);
    queryReader.unmount();
  });

  it('preserves server reconcile order across pages with no client resort', async () => {
    const page1: FeedResponse = {
      feed: { nodes: [{ id: 'm3', vibeId: 'v1', sequenceNumber: 103 }, { id: 'm1', vibeId: 'v1', sequenceNumber: 101 }], pageInfo: { hasNextPage: true, endCursor: 'c1' }, lastSequenceNumber: 101 }
    };
    const page2: FeedResponse = {
      feed: { nodes: [{ id: 'm5', vibeId: 'v1', sequenceNumber: 105 }, { id: 'm2', vibeId: 'v1', sequenceNumber: 102 }], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 102 }
    };
    const responses = [page1, page2];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected query response');
        return { data: next as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('ServerOrder');
    const feedQuery = moments.query<FeedResponse, ScopeValue & { afterSequence?: number }, ScopeValue, FeedRow>('feed', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      coverage: 'page',
      getCursor: page => String((page as FeedResponse['feed']).lastSequenceNumber),
      cursorVar: 'afterSequence',
      mapCursor: cursor => Number(cursor)
    });

    const scopeReader = renderCounted(() => moments.scopes.feed.use({ vibeId: 'v1' }));
    const queryReader = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    expect(scopeReader.result().map(row => row.id)).toEqual(['m3', 'm1']);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });

    // Server order is preserved even though m5 (sequenceNumber 105) is numerically newer than m3 -
    // the scope's `server-order` sort never resorts by field; reconcile order alone decides position.
    expect(scopeReader.result().map(row => row.id)).toEqual(['m3', 'm1', 'm5', 'm2']);
    scopeReader.unmount();
    queryReader.unmount();
  });

  it('hasNextPage goes false on a short page; showFooterSpinner is true only during the next-page fetch', async () => {
    const page1: FeedResponse = {
      feed: { nodes: [{ id: 'm2', vibeId: 'v1', sequenceNumber: 102 }, { id: 'm1', vibeId: 'v1', sequenceNumber: 101 }], pageInfo: { hasNextPage: true, endCursor: 'c1' }, lastSequenceNumber: 101 }
    };
    let resolvePage2!: (value: { data: FeedResponse }) => void;
    let queryCalls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        queryCalls += 1;
        if (queryCalls === 1) return { data: page1 as TData };
        return new Promise<{ data: TData }>(resolve => {
          resolvePage2 = resolve as never;
        });
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('Spinner');
    const feedQuery = moments.query<FeedResponse, ScopeValue & { afterSequence?: number }, ScopeValue, FeedRow>('feed', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      coverage: 'page',
      getCursor: page => String((page as FeedResponse['feed']).lastSequenceNumber),
      cursorVar: 'afterSequence',
      mapCursor: cursor => Number(cursor)
    });

    const queryReader = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    expect(queryReader.result().loadingState.showFooterSpinner).toBe(false);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });
    expect(queryReader.result().isFetchingNextPage).toBe(true);
    expect(queryReader.result().loadingState.showFooterSpinner).toBe(true);

    const page2: FeedResponse = {
      feed: { nodes: [{ id: 'm0', vibeId: 'v1', sequenceNumber: 100 }], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 100 }
    };
    await act(async () => {
      resolvePage2({ data: page2 });
      await settle();
      await settle(1, { macro: true });
    });

    expect(queryReader.result().hasNextPage).toBe(false);
    expect(queryReader.result().loadingState.showFooterSpinner).toBe(false);
    queryReader.unmount();
  });

  it('lands a relay connection through the connection shorthand with dense nodes and cursor paging', async () => {
    type SparseResponse = { feed: { nodes: Array<FeedRow | null>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
    const responses: SparseResponse[] = [
      {
        feed: {
          nodes: [{ id: 'm2', vibeId: 'v1', sequenceNumber: 102 }, null, { id: 'm1', vibeId: 'v1', sequenceNumber: 101 }],
          pageInfo: { hasNextPage: true, endCursor: 'c1' }
        }
      },
      {
        feed: {
          nodes: [{ id: 'm0', vibeId: 'v1', sequenceNumber: 100 }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    ];
    const transport = createMockTransport({
      query: async <TData,>() => {
        const next = responses.shift();
        if (!next) throw new Error('Unexpected query response');
        return { data: next as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('ConnectionShorthand');
    const feedQuery = moments.query<SparseResponse, ScopeValue & { after?: string }, ScopeValue, FeedRow>('feed-connection-shorthand', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      connection: data => data.feed,
      into: moments.scopes.feed,
      coverage: 'page'
    });

    const queryReader = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    expect(queryReader.result().data.map(row => row.id)).toEqual(['m2', 'm1']);
    expect(queryReader.result().hasNextPage).toBe(true);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });

    expect(queryReader.result().data.map(row => row.id)).toEqual(['m2', 'm1', 'm0']);
    expect(queryReader.result().hasNextPage).toBe(false);
    queryReader.unmount();
  });

  it('holds a query inactive while a declared required scope key is nullish', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          feed: {
            nodes: [{ id: 'm1', vibeId: 'v1', sequenceNumber: 101 }],
            pageInfo: { hasNextPage: false, endCursor: null },
            lastSequenceNumber: 101
          }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('RequiredScope');
    const feedQuery = moments.query<FeedResponse, ScopeValue, { vibeId: string | null }, FeedRow>('feed-required-scope', {
      document,
      vars: value => ({ vibeId: value.vibeId! }),
      page: data => data.feed,
      into: moments.scopes.feed as never,
      requiredScope: ['vibeId']
    });

    const gatedReader = renderCountedInProvider(() => feedQuery.use({ vibeId: null }));
    await settle();
    await settle(1, { macro: true });
    expect(transport.calls).toHaveLength(0);
    gatedReader.unmount();

    const activeReader = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    expect(transport.calls).toHaveLength(1);
    expect(activeReader.result().data.map(row => row.id)).toEqual(['m1']);
    activeReader.unmount();
  });

  it('serves a bridged window from a scope query: local window first, then the next server page', async () => {
    const pageAt = (start: number, hasNextPage: boolean): FeedResponse => ({
      feed: {
        nodes: Array.from({ length: 3 }, (_, index) => ({ id: `m${start - index}`, vibeId: 'v1', sequenceNumber: start - index })),
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${start - 2}` : null },
        lastSequenceNumber: start - 2
      }
    });
    const responses = [pageAt(106, true), pageAt(103, false)];
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('BridgedWindow');
    const feedQuery = moments.query<FeedResponse, ScopeValue & { afterSequence?: number }, ScopeValue, FeedRow>('feed-bridged-window', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      coverage: 'page',
      getCursor: page => String((page as FeedResponse['feed']).lastSequenceNumber),
      cursorVar: 'afterSequence',
      mapCursor: cursor => Number(cursor)
    });

    const reader = renderCountedInProvider(() => feedQuery.useWindow({ vibeId: 'v1' }, { pageSize: 2 }));
    await settle();
    await settle(1, { macro: true });

    expect(reader.result().rows.map(row => row.id)).toEqual(['m106', 'm105']);
    expect(reader.result().hasNextPage).toBe(true);
    expect(transport.calls).toHaveLength(1);

    act(() => {
      reader.result().fetchNextPage();
    });
    await settle();
    expect(reader.result().rows.map(row => row.id)).toEqual(['m106', 'm105', 'm104']);
    expect(transport.calls).toHaveLength(1);

    act(() => {
      reader.result().fetchNextPage();
    });
    await settle();
    await settle(1, { macro: true });
    expect(transport.calls).toHaveLength(2);
    expect(reader.result().rows.map(row => row.id)).toEqual(['m106', 'm105', 'm104', 'm103']);
    reader.unmount();
  });

  it('debounces bridged loadMore bursts into one guarded advance', async () => {
    const pageAt = (start: number, hasNextPage: boolean): FeedResponse => ({
      feed: {
        nodes: [{ id: `m${start}`, vibeId: 'v1', sequenceNumber: start }],
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${start}` : null },
        lastSequenceNumber: start
      }
    });
    const responses = [pageAt(106, true), pageAt(105, false)];
    const transport = createMockTransport({
      query: async <TData,>() => ({ data: responses.shift() as TData })
    });
    configureDb({ storage: createMemoryPlane(), transport });
    const moments = createMoments('DebouncedLoadMore');
    const feedQuery = moments.query<FeedResponse, ScopeValue & { afterSequence?: number }, ScopeValue, FeedRow>('feed-debounced-load-more', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      coverage: 'page',
      getCursor: page => String((page as FeedResponse['feed']).lastSequenceNumber),
      cursorVar: 'afterSequence',
      mapCursor: cursor => Number(cursor)
    });

    const reader = renderCountedInProvider(() => feedQuery.useWindow({ vibeId: 'v1' }, { pageSize: 1 }));
    await settle();
    await settle(1, { macro: true });
    expect(transport.calls).toHaveLength(1);

    act(() => {
      reader.result().loadMore();
      reader.result().loadMore();
      reader.result().loadMore();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 220));
    });
    await settle();
    await settle(1, { macro: true });

    expect(transport.calls).toHaveLength(2);
    expect(reader.result().rows.map(row => row.id)).toEqual(['m106']);
    expect(reader.result().totalCount).toBe(2);
    reader.unmount();
  });

  it('resolves a named freshness class from configureDb defaults and rejects an unknown name', async () => {
    const transport = createMockTransport({
      query: async <TData,>() => ({
        data: {
          feed: { nodes: [{ id: 'm1', vibeId: 'v1', sequenceNumber: 101 }], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 101 }
        } as TData
      })
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { freshnessClasses: { chat: 60_000 } } });
    const moments = createMoments('FreshnessClass');
    const feedQuery = moments.query<FeedResponse, ScopeValue, ScopeValue, FeedRow>('feed-freshness-class', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      staleTime: 'chat'
    });

    const first = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    first.unmount();
    expect(transport.calls).toHaveLength(1);

    const second = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    second.unmount();
    expect(transport.calls).toHaveLength(1);

    const brokenQuery = moments.query<FeedResponse, ScopeValue, ScopeValue, FeedRow>('feed-freshness-unknown', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      staleTime: 'nonexistent'
    });
    await expect(brokenQuery.fetch({ vibeId: 'v1' })).rejects.toThrow('unknown freshness class');
  });

  it('resolves a named freshness class for emptyStaleTime', async () => {
    let calls = 0;
    const transport = createMockTransport({
      query: async <TData,>() => {
        calls += 1;
        return { data: { feed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 0 } } as TData };
      }
    });
    configureDb({ storage: createMemoryPlane(), transport, defaults: { freshnessClasses: { emptyRetry: 0 }, staleTime: 3_600_000 } });
    const moments = createMoments('FreshnessEmptyClass');
    const feedQuery = moments.query<FeedResponse, ScopeValue, ScopeValue, FeedRow>('feed-empty-freshness-class', {
      document,
      vars: value => ({ vibeId: value.vibeId }),
      page: data => data.feed,
      into: moments.scopes.feed,
      emptyStaleTime: 'emptyRetry'
    });

    const first = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    first.unmount();
    expect(calls).toBe(1);

    const second = renderCountedInProvider(() => feedQuery.use({ vibeId: 'v1' }));
    await settle();
    await settle(1, { macro: true });
    second.unmount();
    expect(calls).toBe(2);
  });
});
