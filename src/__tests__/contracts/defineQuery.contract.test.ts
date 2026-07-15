import type { QueryClient } from '@tanstack/react-query';
import { buildScopeKey } from '../../core/compileDbWhere';
import { defineIngest } from '../../dsl/defineIngest';
import { defineModel } from '../../dsl/defineModel';
import { defineQuery } from '../../dsl/defineQuery';
import { getApplyRuntime } from '../../dsl/configure';
import { resetRuntimeSync } from '../../core/reset';
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

    resetRuntimeSync();
    resolveTransport({ data: { items: [{ id: 'server', title: 'old-world' }] } });

    await pending;
    expect(Model.getAll()).toEqual([]);
    expect(scenario.storage.keys('dbl:journal:')).toEqual([]);
    expect(getApplyRuntime().currentEpoch()).toBe(0);
  });
});
