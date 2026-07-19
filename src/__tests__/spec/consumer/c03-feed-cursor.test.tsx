import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

// Mirrors yupi_v2 src/db/queries/useFeed.ts: server-order scope, cursor pagination keyed off the
// LAST row's sequenceNumber (getCursor + mapCursor Number), maxPages-bounded infinite query.

type FeedRow = { id: string; vibeId: string; sequenceNumber: number };
type FeedResponse = { feed: { nodes: FeedRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; lastSequenceNumber: number } };
type ScopeValue = { vibeId: string };
type CallEntry = { kind: 'query'; operation: { variables: { vibeId: string; afterSequence?: number } } };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  // A macrotask flush in addition to the microtask ticks above - under concurrent test-file load
  // some scheduling hops land on a macrotask, and pure Promise.resolve() ticks can race ahead of it.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const createMoments = (suffix: string) =>
  defineModel({
    id: `SpecConsumerFeedCursor${suffix}`,
    name: `SpecConsumerFeedCursor${suffix}`,
    fields: { id: f.str(), vibeId: f.str(), sequenceNumber: f.num() },
    scopes: {
      feed: scope<FeedRow>({ by: { vibeId: 'vibeId' }, sort: 'server-order' })
    }
  });

const renderCountedInProvider = <T,>(useHook: () => T) => {
  let value!: T;
  let renderCount = 0;
  let root!: TestRenderer.ReactTestRenderer;

  const Reader = () => {
    value = useHook();
    renderCount += 1;
    return null;
  };

  act(() => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });

  return {
    result: () => value,
    renders: () => renderCount,
    unmount: () => act(() => root.unmount())
  };
};

describe('feed cursor pagination consumer contracts', () => {
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

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();

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
    expect(scopeReader.result().map(row => row.id)).toEqual(['m3', 'm1']);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();

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
    expect(queryReader.result().loadingState.showFooterSpinner).toBe(false);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();
    expect(queryReader.result().isFetchingNextPage).toBe(true);
    expect(queryReader.result().loadingState.showFooterSpinner).toBe(true);

    const page2: FeedResponse = {
      feed: { nodes: [{ id: 'm0', vibeId: 'v1', sequenceNumber: 100 }], pageInfo: { hasNextPage: false, endCursor: null }, lastSequenceNumber: 100 }
    };
    await act(async () => {
      resolvePage2({ data: page2 });
      await settle();
    });

    expect(queryReader.result().hasNextPage).toBe(false);
    expect(queryReader.result().loadingState.showFooterSpinner).toBe(false);
    queryReader.unmount();
  });
});
