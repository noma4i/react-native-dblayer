import type { DocumentNode } from 'graphql';
import { act } from 'react';
import { configureDb, defineModelRuntime, f } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted, renderCountedInProvider, settle, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; accountId: string; title: string };

const createRows = (suffix: string) =>
  defineModelRuntime({
    id: `ScopeValueGuard${suffix}`,
    name: `ScopeValueGuard${suffix}`,
    fields: { id: f.str(), accountId: f.str(), title: f.str() },
    scopes: {
      byAccount: ({ by: { accountId: 'accountId' } }),
      catalog: ({})
    }
  });

const document = {} as DocumentNode;

const createQuery = (rows: ReturnType<typeof createRows>, vars: (scopeValue: { accountId: string }) => { accountId: string } = scopeValue => ({ accountId: scopeValue.accountId })) =>
  rows.query<{ rows: Row[] }, { accountId: string }, { accountId: string }, Row>('byAccount', {
    document,
    vars,
    select: data => data.rows,
    into: rows.scopes.byAccount
  });

describe('by-scope value guard', () => {
  it('rejects missing and undefined by fields synchronously at every scope entry point', () => {
    setupSpecRuntime();
    const rows = createRows('Invalid');

    expect(() => rows.scopes.byAccount.seed({} as never, [])).toThrow('ScopeValueGuardInvalid.byAccount: scope value must provide accountId');
    expect(() => renderCounted(() => rows.scopes.byAccount.use({} as never))).toThrow('ScopeValueGuardInvalid.byAccount: scope value must provide accountId');
    expect(() => renderCounted(() => rows.scopes.byAccount.useWindow({ accountId: undefined } as never))).toThrow(
      'ScopeValueGuardInvalid.byAccount: scope value must provide accountId'
    );
  });

  it('keeps null reads disabled without reading the root bucket', () => {
    setupSpecRuntime();
    const rows = createRows('Disabled');
    rows.scopes.byAccount.seed({ accountId: 'account-1' }, [{ id: 'row-1', accountId: 'account-1', title: 'kept' }]);
    const reader = renderCounted(() => rows.scopes.byAccount.use(null));

    expect(reader.result()).toEqual([]);
    reader.unmount();
  });

  it('keeps a null query read idle without callbacks, transport, or a scope subscription', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { rows: [] } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('QueryDisabled');
    const vars = jest.fn((scopeValue: { accountId: string }) => ({ accountId: scopeValue.accountId }));
    const query = createQuery(rows, vars);
    const reader = renderCountedInProvider(() => query.use(null));

    await settle();

    expect(reader.result().data).toEqual([]);
    expect(reader.result().loadingState.phase).toBe('idle');
    expect(vars).not.toHaveBeenCalled();
    expect(transport.calls).toEqual([]);
    const renders = reader.renders();
    act(() => {
      rows.scopes.byAccount.seed({ accountId: 'account-1' }, [{ id: 'row-1', accountId: 'account-1', title: 'kept' }]);
    });
    expect(reader.renders()).toBe(renders);
    reader.unmount();
  });

  it('keeps an imperative null query fetch as a no-op', async () => {
    const transport = createMockTransport({ query: async <TData,>() => ({ data: { rows: [] } as TData }) });
    configureDb({ storage: createMemoryPlane(), transport });
    const rows = createRows('FetchDisabled');
    const vars = jest.fn((scopeValue: { accountId: string }) => ({ accountId: scopeValue.accountId }));
    const query = createQuery(rows, vars);

    await expect(query.fetch(null)).resolves.toBeUndefined();

    expect(vars).not.toHaveBeenCalled();
    expect(transport.calls).toEqual([]);
  });

  it('preserves root catalog scopes and complete by-scope values', () => {
    setupSpecRuntime();
    const rows = createRows('Positive');
    rows.scopes.catalog.seed({}, [{ id: 'catalog-1', accountId: 'account-1', title: 'catalog' }]);
    rows.scopes.byAccount.seed({ accountId: 'account-1' }, [{ id: 'account-1', accountId: 'account-1', title: 'account' }]);

    expect(rows.scopes.catalog.read({}).map(row => row.id)).toEqual(['catalog-1']);
    expect(rows.scopes.byAccount.read({ accountId: 'account-1' }).map(row => row.id)).toEqual(['account-1']);
  });
});
