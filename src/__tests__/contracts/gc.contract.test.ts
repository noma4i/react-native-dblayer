import { belongsTo, collectGarbage, defineModel, f, references, scope } from '../../index';
import { getOperationState } from '../../dsl/configure';
import { createContractScenario } from '../helpers/contractScenario';

/*
 * C1: Unreachable rows are evicted without tombstones and accept later snapshots.
 * C2: Scope members and relation/reference edges are GC roots until their scope detaches.
 * C3: Pending optimistic rows are roots until their operation closes.
 * C4: Dead entries detach and empty scope ledgers are removed from memory and storage.
 * C5: Exempt models keep unscoped rows outside reachability collection.
 */
describe('GC contracts', () => {
  it('C1: eviction creates no tombstone and accepts a later snapshot upsert', () => {
    createContractScenario();
    const Model = defineModel({ id: 'GcEvictContract', name: 'GcEvictContract', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'old' });

    expect(collectGarbage().evicted).toEqual({ GcEvictContract: 1 });
    Model.__applyRows?.([{ id: 'row', title: 'server' }]);
    expect(Model.get('row')).toEqual({ id: 'row', title: 'server' });
  });

  it('C2: scope roots keep related and referenced rows until the scope detaches', () => {
    createContractScenario();
    const Parent = defineModel({ id: 'GcParentContract', name: 'GcParentContract', fields: { title: f.str() } });
    const Target = defineModel({ id: 'GcTargetContract', name: 'GcTargetContract', fields: { title: f.str() } });
    const Child = defineModel({
      id: 'GcChildContract',
      name: 'GcChildContract',
      fields: { parentId: f.id(), targetIds: f.raw<string[]>() },
      relations: () => ({ parent: belongsTo(Parent, { foreignKey: 'parentId' }), targets: references<{ targetIds: string[] }, { id: string }>(Target, { ids: row => row.targetIds }) }),
      scopes: { all: scope({}) }
    });
    Parent.insertStored({ id: 'parent', title: 'kept' });
    Target.insertStored({ id: 'target', title: 'kept' });
    Child.scopes.all.__apply?.({}, [{ id: 'child', parentId: 'parent', targetIds: ['target'] }], 'complete');

    collectGarbage();
    expect(Parent.get('parent')).toBeDefined();
    expect(Target.get('target')).toBeDefined();
    Child.scopes.all.__apply?.({}, [], 'complete');
    expect(collectGarbage().evicted).toEqual({ GcParentContract: 1, GcTargetContract: 1, GcChildContract: 1 });
  });

  it('C3: pending-operation rows remain reachable until the operation commits', () => {
    createContractScenario();
    const Model = defineModel({ id: 'GcPendingContract', name: 'GcPendingContract', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'kept' });
    getOperationState().begin({ operationId: 'operation', model: 'GcPendingContract', tempIds: ['row'], intent: 'insert', createdAt: 0 });

    collectGarbage();
    expect(Model.get('row')).toBeDefined();
    getOperationState().close('operation', 'committed');
    expect(collectGarbage().evicted).toEqual({ GcPendingContract: 1 });
  });

  it('C4: empty and dead scope ledgers are removed during collection', () => {
    const scenario = createContractScenario();
    const Model = defineModel({ id: 'GcScopeContract', name: 'GcScopeContract', fields: { title: f.str() }, scopes: { all: scope({}) } });
    Model.scopes.all.__apply?.({}, [{ id: 'row', title: 'gone' }], 'complete');
    Model.scopes.all.__apply?.({}, [], 'complete');

    expect(collectGarbage().scopesRemoved).toEqual({ GcScopeContract: 1 });
    expect(Model.scopes.all.read({})).toEqual([]);
    expect(scenario.values.has('dbl:scope:GcScopeContract:all:__root__')).toBe(false);
  });

  it('C4: a hydrated dead entry is detached before its empty scope is removed', () => {
    const scenario = createContractScenario();
    scenario.values.set('dbl:scope:GcDeadEntryContract:all:__root__', JSON.stringify({ generation: 1, coverage: 'complete', entries: [{ id: 'missing', order: 0, seq: 1 }] }));
    const Model = defineModel({ id: 'GcDeadEntryContract', name: 'GcDeadEntryContract', fields: { title: f.str() }, scopes: { all: scope({}) } });

    expect(collectGarbage().scopesRemoved).toEqual({ GcDeadEntryContract: 1 });
    expect(Model.scopes.all.read({})).toEqual([]);
  });

  it('C5: exempt models preserve their unscoped rows', () => {
    createContractScenario();
    const Model = defineModel({ id: 'GcExemptContract', name: 'GcExemptContract', fields: { title: f.str() }, gc: 'exempt' });
    Model.insertStored({ id: 'row', title: 'kept' });

    expect(collectGarbage().evicted).not.toHaveProperty('GcExemptContract');
    expect(Model.get('row')).toEqual({ id: 'row', title: 'kept' });
  });
});
