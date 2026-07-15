import { belongsTo, expandPlan, hasMany } from '../../core/relations';
import { defineModel } from '../../dsl/defineModel';
import { getApplyRuntime } from '../../dsl/configure';
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

  it('C4: same-plan parent creation and destroy cascades an overlay child deterministically', () => {
    createContractScenario();
    const Child = defineModel({ id: 'OverlayChildContract', name: 'OverlayChildContract', fields: { parentId: f.id() } });
    const Parent = defineModel({ id: 'OverlayParentContract', name: 'OverlayParentContract', fields: {}, relations: () => ({ children: hasMany(Child, { foreignKey: 'parentId', dependent: 'destroy' }) }) });

    const expanded = expandPlan([
      { kind: 'upsert', model: Parent.modelId, rows: [{ id: 'parent' }] },
      { kind: 'upsert', model: Child.modelId, rows: [{ id: 'child', parentId: 'parent' }] },
      { kind: 'destroy', model: Parent.modelId, ids: ['parent'] }
    ]);

    expect(expanded.some(op => op.kind === 'destroy' && op.model === Child.modelId && op.ids.includes('child'))).toBe(true);
    getApplyRuntime().apply(expanded);
    expect(Parent.get('parent')).toBeUndefined();
    expect(Child.get('child')).toBeUndefined();
  });

  it('C5: a same-plan parent reassignment prevents a stale dependent cascade', () => {
    createContractScenario();
    const Child = defineModel({ id: 'ReassignedChildContract', name: 'ReassignedChildContract', fields: { parentId: f.id() } });
    const Parent = defineModel({ id: 'ReassignedParentContract', name: 'ReassignedParentContract', fields: {}, relations: () => ({ children: hasMany(Child, { foreignKey: 'parentId', dependent: 'destroy' }) }) });
    Parent.insertStored({ id: 'a' });
    Parent.insertStored({ id: 'b' });
    Child.insertStored({ id: 'child', parentId: 'a' });

    const expanded = expandPlan([
      { kind: 'patch', model: Child.modelId, id: 'child', patch: { parentId: 'b' } },
      { kind: 'destroy', model: Parent.modelId, ids: ['a'] }
    ]);

    expect(expanded.some(op => op.kind === 'destroy' && op.model === Child.modelId && op.ids.includes('child'))).toBe(false);
    getApplyRuntime().apply(expanded);
    expect(Child.get('child')).toEqual({ id: 'child', parentId: 'b' });
  });
});
