import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DbProvider, configureDb, defineFetch, defineModel, f, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, setupSpecRuntime } from '../helpers/harness';

type Item = { id: string; bucket: string };
type QueryResponse = { items: { nodes: Item[]; pageInfo: { hasNextPage: false; endCursor: null } } };

const document = { kind: 'Document', definitions: [] } as never;

const settle = async () => {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
};

const mountTwice = async (Reader: React.ComponentType): Promise<void> => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });
  await settle();
  act(() => root.unmount());
  await act(async () => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });
  await settle();
  act(() => root.unmount());
};

const createQueryCase = (suffix: string, rows: Item[], options: { emptyStaleTime?: number; defaultsEmptyStaleTime?: number }) => {
  let calls = 0;
  const transport = createMockTransport({
    query: async () => {
      calls += 1;
      return { data: { items: { nodes: rows, pageInfo: { hasNextPage: false, endCursor: null } } } as never };
    }
  });
  configureDb({
    storage: createMemoryPlane(),
    transport,
    defaults: { staleTime: 60 * 60 * 1000, emptyStaleTime: options.defaultsEmptyStaleTime }
  });
  const items = defineModel({
    id: `SpecEmptyQuery${suffix}`,
    name: `SpecEmptyQuery${suffix}`,
    fields: { bucket: f.str() },
    scopes: { byBucket: scope<Item>({ sort: 'server-order' }) }
  });
  const query = items.query<QueryResponse, Record<string, never>, { bucket: string }, Item>('list', {
    document,
    vars: () => ({}),
    page: data => data.items,
    into: items.scopes.byBucket,
    staleTime: 60 * 60 * 1000,
    emptyStaleTime: options.emptyStaleTime
  });
  const Reader = () => {
    query.use({ bucket: 'A' });
    return null;
  };
  return { Reader, calls: () => calls };
};

describe('empty result freshness policy', () => {
  it('refetches an empty model query immediately on the next mount', async () => {
    const testCase = createQueryCase('Empty', [], { emptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(2);
  });

  it('keeps a non-empty model query fresh for its normal stale time', async () => {
    const testCase = createQueryCase('NonEmpty', [{ id: 'item-1', bucket: 'A' }], { emptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(1);
  });

  test.failing('GATE-PENDING(G8): refetches an empty standalone fetch immediately on the next mount', async () => {
    setupSpecRuntime();
    let calls = 0;
    const request = defineFetch<number[], void, number[]>({
      key: 'empty-fetch-empty',
      fetcher: async () => {
        calls += 1;
        return [];
      },
      select: (data: number[]) => data,
      staleTime: 60 * 60 * 1000,
      emptyStaleTime: 0,
      isEmpty: (data: number[]) => data.length === 0
    } as never);
    const Reader = () => {
      request.use(undefined);
      return null;
    };

    await mountTwice(Reader);

    expect(calls).toBe(2);
  });

  it('keeps a non-empty standalone fetch fresh for its normal stale time', async () => {
    setupSpecRuntime();
    let calls = 0;
    const request = defineFetch<number[], void, number[]>({
      key: 'empty-fetch-non-empty',
      fetcher: async () => {
        calls += 1;
        return [1];
      },
      select: (data: number[]) => data,
      staleTime: 60 * 60 * 1000,
      emptyStaleTime: 0,
      isEmpty: (data: number[]) => data.length === 0
    } as never);
    const Reader = () => {
      request.use(undefined);
      return null;
    };

    await mountTwice(Reader);

    expect(calls).toBe(1);
  });

  it('flows the configured empty stale default into model queries', async () => {
    const testCase = createQueryCase('Default', [], { defaultsEmptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(2);
  });

  test.failing('GATE-PENDING(G8): flows the configured empty stale default into standalone fetches', async () => {
    const transport = createMockTransport();
    configureDb({ storage: createMemoryPlane(), transport, defaults: { staleTime: 60 * 60 * 1000, emptyStaleTime: 0 } });
    let calls = 0;
    const request = defineFetch<number[], void, number[]>({
      key: 'empty-fetch-default',
      fetcher: async () => {
        calls += 1;
        return [];
      },
      select: data => data
    });
    const Reader = () => {
      request.use(undefined);
      return null;
    };

    await mountTwice(Reader);

    expect(calls).toBe(2);
  });
});
