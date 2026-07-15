import { belongsTo, expandPlan, hasMany } from '../../core/relations';
import { defineModel } from '../../dsl/defineModel';
import { f } from '../../schema/f';
import { createContractScenario } from '../helpers/contractScenario';

/*
 * C1: Dependent ownership cascades only from an explicit parent destroy.
 * C2: Query-only belongsTo relations do not grant lifecycle authority to the parent.
 * C3: Touch folds event rows per parent and counterCache deduplicates insertion and decrements destroy.
 */
describe('Relations contracts', () => {
  it('C1: explicit parent destroy cascades to dependent children', () => {
    createContractScenario();
    const Child = defineModel({ id: 'DependentChildContract', name: 'DependentChildContract', fields: { parentId: f.id() } });
    const Parent = defineModel({ id: 'DependentParentContract', name: 'DependentParentContract', fields: {}, relations: () => ({ children: hasMany(Child, { foreignKey: 'parentId', dependent: 'destroy' }) }) });
    Parent.insertStored({ id: 'parent' });
    Child.insertStored({ id: 'child', parentId: 'parent' });

    Parent.destroy('parent');

    expect(Parent.get('parent')).toBeUndefined();
    expect(Child.get('child')).toBeUndefined();
  });

  it('C2: a query-only belongsTo relation preserves its child when the parent is destroyed', () => {
    createContractScenario();
    const Parent = defineModel({ id: 'QueryParentContract', name: 'QueryParentContract', fields: {} });
    const Child = defineModel({ id: 'QueryChildContract', name: 'QueryChildContract', fields: { parentId: f.id() }, relations: () => ({ parent: belongsTo(Parent, { foreignKey: 'parentId' }) }) });
    Parent.insertStored({ id: 'parent' });
    Child.insertStored({ id: 'child', parentId: 'parent' });

    Parent.destroy('parent');

    expect(Child.get('child')).toEqual({ id: 'child', parentId: 'parent' });
  });

  it('C3: touch folds event rows and counterCache deduplicates insertions before decrementing destroy', () => {
    createContractScenario();
    const Parent = defineModel({ id: 'EffectsParentContract', name: 'EffectsParentContract', fields: { count: f.num(), activity: f.num() } });
    const Child = defineModel({
      id: 'EffectsChildContract',
      name: 'EffectsChildContract',
      fields: { parentId: f.id(), activity: f.num() },
      relations: () => ({ parent: belongsTo(Parent, { foreignKey: 'parentId', touch: (child, parent) => ({ activity: Math.max(Number(parent.activity), Number((child as { activity?: number }).activity)) }), counterCache: { field: 'count' } }) })
    });
    Parent.insertStored({ id: 'parent', count: 0, activity: 0 });
    const expanded = expandPlan([{ kind: 'upsert', model: 'EffectsChildContract', rows: [{ id: 'one', parentId: 'parent', activity: 5 }, { id: 'two', parentId: 'parent', activity: 3 }] }]);

    expect(expanded.filter(op => op.kind === 'patch' && op.model === 'EffectsParentContract')).toHaveLength(1);
    Child.insertStored({ id: 'one', parentId: 'parent', activity: 5 });
    Child.insertStored({ id: 'one', parentId: 'parent', activity: 5 });
    expect(Parent.get('parent')?.count).toBe(1);
    Child.destroy('one');
    expect(Parent.get('parent')?.count).toBe(0);
  });
});
