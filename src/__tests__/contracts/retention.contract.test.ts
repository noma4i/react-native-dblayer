import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createContractScenario } from '../helpers/contractScenario';

/*
 * C1: Page accumulation does not trim mid-session, while resetOrder trims to maxRows.
 * C2: Complete coverage applies maxRows retention immediately.
 */
describe('Retention contracts', () => {
  it('C1: loaded pages stay intact until a first-page resetOrder reconcile applies retention', () => {
    createContractScenario();
    const Model = defineModel({ id: 'RetentionPageContract', name: 'RetentionPageContract', fields: { title: f.str() }, scopes: { feed: scope({ sort: 'server-order', retention: { maxRows: 3 } }) } });
    Model.scopes.feed.__apply?.({}, [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }], 'page');
    Model.scopes.feed.__apply?.({}, [{ id: 'c', title: 'c' }, { id: 'd', title: 'd' }], 'page');

    expect(Model.scopes.feed.read({}).map(row => row.id)).toEqual(['a', 'b', 'c', 'd']);
    Model.scopes.feed.__apply?.({}, [{ id: 'n', title: 'n' }, { id: 'a', title: 'a' }], 'page', { resetOrder: true });
    expect(Model.scopes.feed.read({}).map(row => row.id)).toEqual(['n', 'a', 'b']);
  });

  it('C2: complete coverage trims the scope to its configured maximum', () => {
    createContractScenario();
    const Model = defineModel({ id: 'RetentionCompleteContract', name: 'RetentionCompleteContract', fields: { title: f.str() }, scopes: { feed: scope({ sort: 'server-order', retention: { maxRows: 3 } }) } });

    Model.scopes.feed.__apply?.({}, [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c' }, { id: 'd', title: 'd' }], 'complete');

    expect(Model.scopes.feed.read({}).map(row => row.id)).toEqual(['a', 'b', 'c']);
  });
});
