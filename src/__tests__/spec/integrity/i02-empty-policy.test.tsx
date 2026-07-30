import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { DbProvider, configureDb, defineFetch, defineModel, f } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted, setupSpecRuntime, settle } from '../helpers/harness';

type Item = { id: string; bucket: string };
type QueryResponse = { items: { nodes: Item[]; pageInfo: { hasNextPage: false; endCursor: null } } };

const document = { kind: 'Document', definitions: [] } as never;

const mountTwice = async (Reader: React.ComponentType): Promise<void> => {
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });
  await settle(4, { macro: true });
  act(() => root.unmount());
  await act(async () => {
    root = TestRenderer.create(React.createElement(DbProvider, null, React.createElement(Reader)));
  });
  await settle(4, { macro: true });
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
    scopes: { byBucket: ({ sort: 'server-order' }) }
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

const createDirectModelQueryCase = (suffix: string, rows: Item[]) => {
  let calls = 0;
  const transport = createMockTransport({
    query: async () => {
      calls += 1;
      return { data: { rows } as never };
    }
  });
  configureDb({ storage: createMemoryPlane(), transport });
  const items = defineModel({
    id: `SpecEmptyDirectModelQuery${suffix}`,
    name: `SpecEmptyDirectModelQuery${suffix}`,
    fields: { bucket: f.str() },
    scopes: { byBucket: ({ by: { bucket: 'bucket' } }) }
  });
  const query = items.query<{ rows: Item[] }, Record<string, never>, Record<string, never>, Item>('list', {
    document,
    vars: value => value,
    select: data => data.rows,
    into: items,
    staleTime: 60 * 60 * 1000,
    emptyStaleTime: 0
  });
  const Reader = () => {
    query.use({});
    return null;
  };
  return { Reader, calls: () => calls, keepAlive: () => renderCounted(() => items.scopes.byBucket.use({ bucket: 'A' })) };
};

describe('empty result freshness policy', () => {
  it('refetches an empty scope-destination query immediately on the next mount', async () => {
    const testCase = createQueryCase('Empty', [], { emptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(2);
  });

  it('keeps a non-empty scope-destination query fresh for its normal stale time', async () => {
    const testCase = createQueryCase('NonEmpty', [{ id: 'item-1', bucket: 'A' }], { emptyStaleTime: 0 });

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(1);
  });

  it('refetches an empty direct-model query immediately on the next mount', async () => {
    const testCase = createDirectModelQueryCase('Empty', []);

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(2);
  });

  it('keeps a non-empty direct-model query fresh for its normal stale time', async () => {
    const testCase = createDirectModelQueryCase('NonEmpty', [{ id: 'item-1', bucket: 'A' }]);
    const keeper = testCase.keepAlive();

    await mountTwice(testCase.Reader);

    expect(testCase.calls()).toBe(1);
    keeper.unmount();
  });

  it('refetches an empty standalone fetch immediately on the next mount', async () => {
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
    });
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
    });
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

  it('flows the configured empty stale default into standalone fetches', async () => {
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
