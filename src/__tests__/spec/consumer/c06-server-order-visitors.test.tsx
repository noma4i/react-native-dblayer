import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type ScopeValue = { momentId: string };
type QueryResponse = {
  moments: {
    nodes: Array<{ id: string; momentId: string; fullName: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type QueryOperation = { variables: { momentId: string; after?: string | null } };

type VisitorRow = { id: string; momentId: string; fullName: string };

type CallEntry = { kind: 'query'; operation: QueryOperation };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const createVisitorModel = () =>
  defineModel({
    id: 'SpecConsumerVisitor',
    name: 'SpecConsumerVisitor',
    fields: {
      id: f.str(),
      momentId: f.str(),
      fullName: f.str()
    },
    scopes: {
      visitors: scope<ScopeValue>({ by: { momentId: 'momentId' }, sort: 'server-order' })
    }
  });

const createQueueTransport = (responses: QueryResponse[]) => {
  const transport = createMockTransport({
    query: async <TData,>() => {
      const next = responses.shift();
      if (!next) throw new Error('Unexpected query response');
      return { data: next as TData };
    }
  });
  return transport as unknown as ReturnType<typeof createMockTransport> & { calls: Array<CallEntry> };
};

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

describe('server-order visitor scope behavior', () => {
  it('renders pages in exact server order without client-side reorder', async () => {
    const responses = [
      {
        moments: {
          nodes: [
            { id: 'u3', momentId: 'moment-1', fullName: 'u3' },
            { id: 'u1', momentId: 'moment-1', fullName: 'u1' }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-u1' }
        }
      },
      {
        moments: {
          nodes: [
            { id: 'u5', momentId: 'moment-1', fullName: 'u5' },
            { id: 'u2', momentId: 'moment-1', fullName: 'u2' }
          ],
          pageInfo: { hasNextPage: false, endCursor: 'cursor-u2' }
        }
      }
    ];

    const transport = createQueueTransport(responses);
    configureDb({ storage: createMemoryPlane(), transport });
    const visitors = createVisitorModel();
    const query = visitors.query<QueryResponse, ScopeValue & { after?: string | null }, ScopeValue, VisitorRow>('visitors', {
      document,
      vars: value => ({ momentId: value.momentId }),
      page: data => ({ nodes: data.moments.nodes, pageInfo: data.moments.pageInfo }),
      into: visitors.scopes.visitors,
      coverage: 'page'
    });

    const scopeReader = renderCounted(() => visitors.scopes.visitors.use({ momentId: 'moment-1' }));
    const queryReader = renderCountedInProvider(() => query.use({ momentId: 'moment-1' }));

    await settle();
    expect(scopeReader.result().map(row => row.id)).toEqual(['u3', 'u1']);

    act(() => {
      queryReader.result().fetchNextPage();
    });
    await settle();

    expect(scopeReader.result().map(row => row.id)).toEqual(['u3', 'u1', 'u5', 'u2']);
    expect(transport.calls).toHaveLength(2);

    scopeReader.unmount();
    queryReader.unmount();
  });

  it('keeps page coverage idempotent on duplicate payload and rerenders once on real change', async () => {
    const responses = [
      {
        moments: {
          nodes: [
            { id: 'u3', momentId: 'moment-1', fullName: 'u3' },
            { id: 'u1', momentId: 'moment-1', fullName: 'u1' }
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      },
      {
        moments: {
          nodes: [
            { id: 'u3', momentId: 'moment-1', fullName: 'u3' },
            { id: 'u1', momentId: 'moment-1', fullName: 'u1' }
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      },
      {
        moments: {
          nodes: [
            { id: 'u3', momentId: 'moment-1', fullName: 'u3' },
            { id: 'u1', momentId: 'moment-1', fullName: 'u1' },
            { id: 'u5', momentId: 'moment-1', fullName: 'u5' }
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    ];

    const transport = createQueueTransport(responses);
    configureDb({ storage: createMemoryPlane(), transport });
    const visitors = createVisitorModel();
    const query = visitors.query<QueryResponse, ScopeValue, ScopeValue, VisitorRow>('re-fetch', {
      document,
      vars: value => ({ momentId: value.momentId }),
      page: data => ({ nodes: data.moments.nodes, pageInfo: data.moments.pageInfo }),
      into: visitors.scopes.visitors,
      coverage: 'page'
    });

    const queryReader = renderCountedInProvider(() => query.use({ momentId: 'moment-1' }));
    const scopeReader = renderCounted(() => visitors.scopes.visitors.use({ momentId: 'moment-1' }));

    await settle();
    const initial = scopeReader.result().map(row => row.id);
    const afterInitial = scopeReader.renders();

    act(() => {
      void queryReader.result().refetch();
    });
    await settle();
    expect(scopeReader.renders() - afterInitial).toBe(0);
    expect(scopeReader.result().map(row => row.id)).toEqual(initial);

    const beforeChange = scopeReader.renders();
    act(() => {
      void queryReader.result().refetch();
    });
    await settle();
    expect(scopeReader.result().map(row => row.id)).toEqual(['u3', 'u1', 'u5']);
    expect(scopeReader.renders() - beforeChange).toBe(1);
    expect(transport.calls).toHaveLength(3);

    scopeReader.unmount();
    queryReader.unmount();
  });

  it('does not rerender a scope reader for updates outside scope', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const visitors = createVisitorModel();
    visitors.insertStored({ id: 'u-in', momentId: 'moment-1', fullName: 'In scope' });
    visitors.insertStored({ id: 'u-out', momentId: 'moment-2', fullName: 'Out scope' });

    const scopeReader = renderCounted(() => visitors.scopes.visitors.use({ momentId: 'moment-1' }));
    const renders = scopeReader.renders();

    act(() => {
      visitors.patch('u-out', { fullName: 'Out scope updated' });
    });

    expect(scopeReader.renders() - renders).toBe(0);
    expect(scopeReader.result()).toEqual([{ id: 'u-in', momentId: 'moment-1', fullName: 'In scope' }]);
    scopeReader.unmount();
  });
});
