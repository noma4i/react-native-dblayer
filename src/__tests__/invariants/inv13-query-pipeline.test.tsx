import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parse } from 'graphql';
import TestRenderer, { act } from 'react-test-renderer';
import { flushPersistence, getApplyRuntime, configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { defineQuery } from '../../dsl/defineQuery';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { buildScopeKey } from '../../core/compileDbWhere';

const document = parse('query ItemsList { items { id name } }');

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

const page = (start: number, count: number, hasNextPage = false, endCursor: string | null = null) => ({
  nodes: Array.from({ length: count }, (_, index) => ({ id: String(start + index), name: `item-${start + index}` })),
  pageInfo: { hasNextPage, endCursor }
});

const renderQuery = <T,>(client: QueryClient, read: () => T) => {
  let value: T;
  let root: TestRenderer.ReactTestRenderer;
  const Reader = () => {
    value = read();
    return null;
  };
  act(() => { root = TestRenderer.create(<QueryClientProvider client={client}><Reader /></QueryClientProvider>); });
  return { value: () => value!, unmount: () => act(() => root!.unmount()) };
};

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  throw new Error('query state did not settle');
};

const setup = (responses: Array<unknown | Error>) => {
  const storage = createStorage();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: Array<Record<string, unknown>> = [];
  configureDb({
    storage,
    queryClient: client,
    transport: {
      query: async (operation: any) => {
        calls.push(operation.variables ?? {});
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return { data: next ?? { items: page(1, 0) } };
      },
      mutation: async () => ({ data: {} })
    } as any
  });
  const items = defineModel({ id: 'items', name: 'items', fields: { name: f.str() }, scopes: { list: scope({ sort: 'server-order' }) } });
  const authors = defineModel({ id: 'authors', name: 'authors', fields: { name: f.str() } });
  return { storage, client, calls, items, authors };
};

describe('v6 invariant 13: query pipeline', () => {
  it('loads infinite pages with the cursor and keeps server order', async () => {
    const { client, calls, items } = setup([{ items: page(1, 20, true, 'c1') }, { items: page(21, 20, false, null) }]);
    const query = defineQuery<any, any, any, any>({ document, page: data => data.items, into: items.scopes.list, vars: value => ({ scope: value }) });
    const view = renderQuery(client, () => query.use({ list: 'a' }));
    await waitFor(() => view.value().data?.length === 20);
    act(() => view.value().loadMore());
    await waitFor(() => view.value().data?.length === 40 && !view.value().hasNextPage);
    expect(calls[1].after).toBe('c1');
    expect(view.value().data?.map((row: any) => row.id)).toEqual(Array.from({ length: 40 }, (_, index) => String(index + 1)));
  });

  it('maps a cursor before passing it to the configured variable', async () => {
    const { client, calls, items } = setup([{ items: page(1, 1, true, '2') }, { items: page(2, 1, false, null) }]);
    const query = defineQuery<any, any, any, any>({ document, page: data => data.items, into: items.scopes.list, cursorVar: 'afterSequence', mapCursor: Number });
    const view = renderQuery(client, () => query.use({ list: 'numeric-cursor' }));
    await waitFor(() => view.value().data?.length === 1);
    act(() => view.value().loadMore());
    await waitFor(() => view.value().data?.length === 2 && !view.value().hasNextPage);
    expect(calls[1].afterSequence).toBe(2);
    expect(typeof calls[1].afterSequence).toBe('number');
  });

  it('detaches missing complete-scope rows without destroying entities', async () => {
    const { items } = setup([{ items: [{ id: '1', name: 'one' }, { id: '2', name: 'two' }, { id: '3', name: 'three' }] }, { items: [{ id: '1', name: 'one' }, { id: '2', name: 'two' }] }]);
    const scopeValue = { list: 'complete' };
    const query = defineQuery<any, any, any, any>({ document, select: data => data.items, into: items.scopes.list, coverage: 'complete' });
    await query.fetch(scopeValue);
    await query.fetch(scopeValue);
    expect(items.scopes.list.read(scopeValue).map((row: any) => row.id)).toEqual(['1', '2']);
    expect(items.get('3')?.name).toBe('three');
  });

  it('applies extracts in the same transaction as primary rows', async () => {
    const { items, authors } = setup([{ items: [{ id: '1', name: 'one' }], authors: [{ id: 'a1', name: 'author' }] }]);
    const query = defineQuery<any, any, any, any>({
      document,
      select: data => data.items,
      into: items.scopes.list,
      extract: data => [{ into: authors, rows: data.data.authors }]
    });
    const before = getApplyRuntime().currentEpoch();
    await query.fetch({ list: 'extract' });
    expect(getApplyRuntime().currentEpoch()).toBe(before + 1);
    expect(authors.get('a1')?.name).toBe('author');
  });

  it('persists edge payloads for edge-format connections', async () => {
    const { storage, items } = setup([{ items: { edges: [{ node: { id: '1', name: 'one' }, sequenceNumber: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }]);
    const query = defineQuery<any, any, any, any>({ document, page: data => data.items, into: items.scopes.list, edge: source => ({ seq: (source as any).sequenceNumber }) });
    await query.fetch({ list: 'edge' });
    flushPersistence();
    const scopeKey = storage.keys('dbl:scope:items:')[0]!;
    expect(JSON.parse(storage.get(scopeKey)!).entries[0].edge).toEqual({ seq: 9 });
  });

  it('routes load-more failures into QueryResult error state', async () => {
    const { client, items } = setup([{ items: page(1, 1, true, 'c1') }, new Error('next failed')]);
    const query = defineQuery<any, any, any, any>({ document, page: data => data.items, into: items.scopes.list });
    const view = renderQuery(client, () => query.use({ list: 'error' }));
    await waitFor(() => view.value().data?.length === 1);
    act(() => view.value().loadMore());
    await waitFor(() => view.value().error?.message === 'next failed');
    expect(view.value().loadingState.showErrorBanner || view.value().loadingState.phase === 'error').toBe(true);
  });

  it('refreshes an entity model without exposing scope data', async () => {
    const { client, items } = setup([{ item: { id: '1', name: 'fresh' } }]);
    const query = defineQuery<any, any, any, any>({ document, select: data => data.item, into: items });
    const view = renderQuery(client, () => query.use({ entity: '1' }));
    await waitFor(() => items.get('1')?.name === 'fresh');
    expect(view.value().data).toBeUndefined();
    expect(items.scopes.list.read({ entity: '1' })).toEqual([]);
  });

  it('stays idle and does not transport when disabled', async () => {
    const { client, calls, items } = setup([{ items: page(1, 1) }]);
    const query = defineQuery<any, any, any, any>({ document, page: data => data.items, into: items.scopes.list, enabled: () => false });
    const view = renderQuery(client, () => query.use({ list: 'disabled' }));
    await act(async () => { await Promise.resolve(); });
    expect(calls).toHaveLength(0);
    expect(view.value().loadingState.phase).toBe('idle');
  });

  it('invalidates only the selected scope or all active scopes', async () => {
    const { client, calls, items } = setup([{ items: page(1, 1) }, { items: page(2, 1) }, { items: page(3, 1) }, { items: page(4, 1) }, { items: page(5, 1) }]);
    const query = defineQuery<any, any, any, any>({ document, page: data => data.items, into: items.scopes.list, vars: value => ({ scope: value }) });
    const first = renderQuery(client, () => query.use({ scope: 'a' }));
    const second = renderQuery(client, () => query.use({ scope: 'b' }));
    await waitFor(() => calls.length === 2);
    const spy = jest.spyOn(client, 'invalidateQueries');
    query.invalidate({ scope: 'a' });
    expect(spy).toHaveBeenLastCalledWith({ queryKey: ['dbl', 'ItemsList', buildScopeKey({ scope: 'a' })] });
    query.invalidate();
    expect(spy).toHaveBeenLastCalledWith({ queryKey: ['dbl', 'ItemsList'] });
    spy.mockRestore();
    first.unmount();
    second.unmount();
  });

  it('treats empty results as stale while retaining non-empty fresh results', async () => {
    const empty = setup([{ items: page(1, 0) }, { items: page(1, 0) }]);
    const emptyScope = { list: 'empty' };
    const emptyQuery = defineQuery<any, any, any, any>({ document, page: data => data.items, into: empty.items.scopes.list, staleTime: Infinity, emptyStaleTime: 0 });
    const firstEmpty = renderQuery(empty.client, () => emptyQuery.use(emptyScope));
    await waitFor(() => empty.calls.length === 1);
    const emptyCached = empty.client.getQueryCache().find({ queryKey: ['dbl', 'ItemsList', buildScopeKey(emptyScope)] });
    await waitFor(() => emptyCached?.state.data !== undefined);
    const emptyOptions = emptyCached!.options as { staleTime: unknown };
    expect(typeof emptyOptions.staleTime).toBe('function');
    expect((emptyOptions.staleTime as (query: any) => number)(emptyCached)).toBe(0);
    firstEmpty.unmount();
    const filled = setup([{ items: page(1, 1) }]);
    const filledScope = { list: 'filled' };
    const filledQuery = defineQuery<any, any, any, any>({ document, page: data => data.items, into: filled.items.scopes.list, staleTime: Infinity, emptyStaleTime: 0 });
    const firstFilled = renderQuery(filled.client, () => filledQuery.use(filledScope));
    await waitFor(() => filled.calls.length === 1);
    const filledCached = filled.client.getQueryCache().find({ queryKey: ['dbl', 'ItemsList', buildScopeKey(filledScope)] });
    await waitFor(() => filledCached?.state.data !== undefined);
    const filledOptions = filledCached!.options as { staleTime: unknown };
    expect(typeof filledOptions.staleTime).toBe('function');
    expect((filledOptions.staleTime as (query: any) => number)(filledCached)).toBe(Infinity);
    firstFilled.unmount();
    const secondFilled = renderQuery(filled.client, () => filledQuery.use(filledScope));
    await act(async () => { await Promise.resolve(); });
    expect(filled.calls).toHaveLength(1);
    secondFilled.unmount();
  });

  it('requires a named operation unless an explicit key is supplied', () => {
    const { items } = setup([]);
    expect(() => defineQuery<any, any, any, any>({ document: parse('{ items { id } }'), page: data => data.items, into: items.scopes.list })).toThrow('defineQuery requires a named operation or an explicit key');
  });
});
