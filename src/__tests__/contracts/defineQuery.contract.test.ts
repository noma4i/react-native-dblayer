import type { QueryClient } from '@tanstack/react-query';
import { QueryClient as QueryClientImpl, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { buildScopeKey } from '../../core/compileDbWhere';
import { defineIngest } from '../../dsl/defineIngest';
import { defineModel } from '../../dsl/defineModel';
import { defineQuery } from '../../dsl/defineQuery';
import { getApplyRuntime } from '../../dsl/configure';
import { resetRuntime } from '../../core/reset';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import type { DbGraphQLDocument } from '../../types';
import { createContractScenario } from '../helpers/contractScenario';

const document = { kind: 'Document', definitions: [] } as unknown as DbGraphQLDocument<unknown, Record<string, unknown>>;

/*
 * C1: Ingest invalidation reaches model-destination queries.
 * C2: Scope handles invalidate the exact scoped query key.
 * C3: First-page refetches reset membership order ahead of retained pages.
 * C4: Page and complete coverage compile their membership semantics correctly.
 * C5: Extract sinks share the primary query transaction epoch.
 * C6: A query response from a pre-reset runtime cannot apply into the new runtime.
 * C7: Per-call enabled gates fetching without changing the scope data path or query key.
 * C8: A failed extract leaves an uncommitted scope plan out of memory and storage.
 */
describe('defineQuery contracts', () => {
  it('C1: ingest invalidation refetch-invalidates a model-destination query', () => {
    const invalidateQueries = jest.fn(async () => undefined);
    createContractScenario({ queryClient: { invalidateQueries } as unknown as QueryClient });
    const Model = defineModel({ id: 'QueryInvalidateContract', name: 'QueryInvalidateContract', fields: { title: f.str() } });
    defineQuery({ document, key: 'modelQuery', select: data => data, into: Model });
    const ingest = defineIngest(Model, { evt: payload => ({ upsert: payload, invalidate: true }) });

    ingest.apply('evt', { id: 'row', title: 'updated' });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dbl', 'modelQuery'] });
  });

  it('C2: scope handle invalidation targets the scope key generated from its raw scope', () => {
    const invalidateQueries = jest.fn(async () => undefined);
    createContractScenario({ queryClient: { invalidateQueries } as unknown as QueryClient });
    const Model = defineModel({ id: 'ScopeInvalidateContract', name: 'ScopeInvalidateContract', fields: { title: f.str() }, scopes: { all: scope({}) } });
    defineQuery({ document, key: 'scopeQuery', select: data => data, into: Model.scopes.all });

    Model.scopes.all.invalidate({ chatId: '1' });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dbl', 'scopeQuery', buildScopeKey({ chatId: '1' })] });
  });

  it('C2b: partial invalidation reaches every registered scope superset and excludes other parents', async () => {
    const invalidateQueries = jest.fn(async () => undefined);
    createContractScenario({ queryClient: { invalidateQueries } as unknown as QueryClient });
    const Model = defineModel({ id: 'SubsetInvalidateContract', name: 'SubsetInvalidateContract', fields: { title: f.str() }, scopes: { all: scope({}) } });
    const query = defineQuery({ document, key: 'subsetQuery', select: data => data, into: Model.scopes.all });

    await query.fetch({ chatId: 'x' });
    await query.fetch({ chatId: 'x', mediaBucket: 'visual' });
    await query.fetch({ chatId: 'y', mediaBucket: 'visual' });
    invalidateQueries.mockClear();
    query.invalidate({ chatId: 'x' });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dbl', 'subsetQuery', buildScopeKey({ chatId: 'x' })] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['dbl', 'subsetQuery', buildScopeKey({ chatId: 'x', mediaBucket: 'visual' })] });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['dbl', 'subsetQuery', buildScopeKey({ chatId: 'y', mediaBucket: 'visual' })] });
  });

  it('C3: a first-page refetch places fresh rows before retained later pages', async () => {
    const responses = [
      { conn: { nodes: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
      { conn: { nodes: [{ id: 'n', title: 'n' }, { id: 'a', title: 'a' }, { id: 'b', title: 'b' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } }
    ];
    createContractScenario({ transport: { query: async <TData>() => ({ data: responses.shift() as TData }) } });
    const Model = defineModel({ id: 'QueryOrderContract', name: 'QueryOrderContract', fields: { title: f.str() }, scopes: { feed: scope({ sort: 'server-order' }) } });
    const query = defineQuery({
      document,
      key: 'pageQuery',
      page: data => (data as { conn: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }).conn,
      into: Model.scopes.feed
    });

    await query.fetch({});
    Model.scopes.feed.__apply?.({}, [{ id: 'c', title: 'c' }], 'page');
    await query.fetch({});

    expect(Model.scopes.feed.read({}).map(row => row.id)).toEqual(['n', 'a', 'b', 'c']);
  });

  it('C4: complete coverage detaches missing members without deleting their entity rows', async () => {
    const responses = [{ items: [{ id: 'one', title: 'one' }, { id: 'two', title: 'two' }] }, { items: [{ id: 'one', title: 'one' }] }];
    createContractScenario({ transport: { query: async <TData>() => ({ data: responses.shift() as TData }) } });
    const Model = defineModel({ id: 'CompleteCoverageContract', name: 'CompleteCoverageContract', fields: { title: f.str() }, scopes: { all: scope({}) } });
    const query = defineQuery({ document, key: 'completeCoverage', select: data => (data as { items: unknown[] }).items, into: Model.scopes.all, coverage: 'complete' });

    await query.fetch({});
    await query.fetch({});

    expect(Model.scopes.all.read({}).map(row => row.id)).toEqual(['one']);
    expect(Model.get('two')).toEqual({ id: 'two', title: 'two' });
  });

  it('C5: extract sinks apply beside primary rows in one query transaction', async () => {
    const { getApplyRuntime } = await import('../../dsl/configure');
    createContractScenario({ transport: { query: async <TData>() => ({ data: { items: [{ id: 'one', title: 'one' }], authors: [{ id: 'author', title: 'author' }] } as TData }) } });
    const Items = defineModel({ id: 'ExtractItemsContract', name: 'ExtractItemsContract', fields: { title: f.str() }, scopes: { all: scope({}) } });
    const Authors = defineModel({ id: 'ExtractAuthorsContract', name: 'ExtractAuthorsContract', fields: { title: f.str() } });
    const query = defineQuery({
      document,
      key: 'extractContract',
      select: data => (data as { items: unknown[] }).items,
      into: Items.scopes.all,
      extract: ctx => [{ into: Authors, rows: (ctx.data as { authors: unknown[] }).authors }]
    });
    const epoch = getApplyRuntime().currentEpoch();

    await query.fetch({});

    expect(getApplyRuntime().currentEpoch()).toBe(epoch + 1);
    expect(Authors.get('author')).toEqual({ id: 'author', title: 'author' });
  });

  it('C6: a resolved pre-reset fetch leaves the new runtime empty', async () => {
    let resolveTransport!: (value: { data: { items: Array<{ id: string; title: string }> } }) => void;
    const scenario = createContractScenario({ transport: { query: <TData>() => new Promise<{ data: { items: Array<{ id: string; title: string }> } }>(resolve => { resolveTransport = resolve; }).then(result => result as { data: TData }) } });
    const Model = defineModel({ id: 'QueryResetContract', name: 'QueryResetContract', fields: { title: f.str() } });
    const query = defineQuery({ document, key: 'queryReset', select: data => (data as { items: unknown[] }).items, into: Model });
    const pending = query.fetch({});

    resetRuntime();
    resolveTransport({ data: { items: [{ id: 'server', title: 'old-world' }] } });

    await pending;
    expect(Model.getAll()).toEqual([]);
    expect(scenario.storage.keys('dbl:journal:')).toEqual([]);
    expect(getApplyRuntime().currentEpoch()).toBe(0);
  });

  it('C7: per-call enabled preserves local scope rows and reuses the real scope query key', async () => {
    let calls = 0;
    const client = new QueryClientImpl({ defaultOptions: { queries: { retry: false } } });
    createContractScenario({
      queryClient: client,
      transport: {
        query: async <TData>() => {
          calls += 1;
          return { data: { items: [{ id: 'remote', title: 'remote' }] } as TData };
        }
      }
    });
    const Model = defineModel({ id: 'PerCallEnabledContract', name: 'PerCallEnabledContract', fields: { title: f.str() }, scopes: { feed: scope({ sort: 'server-order' }) } });
    const scopeValue = { chatId: 'chat-1' };
    Model.scopes.feed.__apply?.(scopeValue, [{ id: 'local', title: 'local' }], 'complete');
    const query = defineQuery({ document, key: 'perCallEnabled', select: data => (data as { items: unknown[] }).items, into: Model.scopes.feed });
    let result!: ReturnType<typeof query.use>;
    const Reader = ({ enabled }: { enabled: boolean }) => {
      result = query.use(scopeValue, { enabled });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(Reader, { enabled: false })));
    });

    expect(calls).toBe(0);
    expect((result.data as Array<{ id: string }>).map(row => row.id)).toEqual(['local']);
    const queryKey = client.getQueryCache().getAll()[0]!.queryKey;
    expect(queryKey).toEqual(['dbl', 'perCallEnabled', buildScopeKey(scopeValue)]);

    await act(async () => {
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Reader, { enabled: true })));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(calls).toBe(1);
    expect(client.getQueryCache().getAll()[0]!.queryKey).toEqual(queryKey);
    renderer.unmount();
  });

  it('C8: a throwing extract does not commit the scope plan before apply', async () => {
    const scenario = createContractScenario({ transport: { query: async <TData>() => ({ data: { items: [{ id: 'row', title: 'row' }] } as TData }) } });
    const Model = defineModel({ id: 'PureScopePlanContract', name: 'PureScopePlanContract', fields: { title: f.str() }, scopes: { feed: scope({}) } });
    const query = defineQuery({
      document,
      key: 'pureScopePlan',
      select: data => (data as { items: unknown[] }).items,
      into: Model.scopes.feed,
      extract: () => {
        throw new Error('extract failed');
      }
    });

    await expect(query.fetch({})).rejects.toThrow('extract failed');
    expect(Model.scopes.feed.read({})).toEqual([]);
    expect(scenario.storage.keys('dbl:scope:PureScopePlanContract:')).toEqual([]);
    expect(scenario.storage.keys('dbl:journal:')).toEqual([]);
  });
});
