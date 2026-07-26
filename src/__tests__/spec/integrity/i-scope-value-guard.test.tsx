import { defineModel, f, scope } from '../../../index';
import { renderCounted, setupSpecRuntime } from '../helpers/harness';

type Row = { id: string; accountId: string; title: string };

const createRows = (suffix: string) =>
  defineModel({
    id: `ScopeValueGuard${suffix}`,
    name: `ScopeValueGuard${suffix}`,
    fields: { id: f.str(), accountId: f.str(), title: f.str() },
    scopes: {
      byAccount: scope<Row>({ by: { accountId: 'accountId' } }),
      catalog: scope<Row>({})
    }
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

  it('preserves root catalog scopes and complete by-scope values', () => {
    setupSpecRuntime();
    const rows = createRows('Positive');
    rows.scopes.catalog.seed({}, [{ id: 'catalog-1', accountId: 'account-1', title: 'catalog' }]);
    rows.scopes.byAccount.seed({ accountId: 'account-1' }, [{ id: 'account-1', accountId: 'account-1', title: 'account' }]);

    expect(rows.scopes.catalog.read({}).map(row => row.id)).toEqual(['catalog-1']);
    expect(rows.scopes.byAccount.read({ accountId: 'account-1' }).map(row => row.id)).toEqual(['account-1']);
  });
});
