import { belongsTo, collectGarbage, defineModel, f, references, scope } from '../index';
import type { StoragePlane } from '../core/planes/storagePlane';
import { configureDb, getOperationState } from '../dsl/configure';

const createStorage = (): { storage: StoragePlane; values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      get: key => values.get(key),
      set: entries => {
        for (const entry of entries) {
          if (entry.value === null) values.delete(entry.key);
          else values.set(entry.key, entry.value);
        }
      },
      keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
    }
  };
};

const setup = () => {
  const { storage, values } = createStorage();
  configureDb({
    storage,
    transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
    defaults: { persistence: { checkpointDelayMs: 10000, maxPendingPlans: 100 } }
  });
  return { storage, values };
};

describe('inv27: GC reachability', () => {
  it('evicts an unscoped row without a tombstone and accepts a later snapshot upsert', () => {
    setup();
    const Model = defineModel({ id: 'GcEvictProbe', name: 'GcEvictProbe', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'old' });

    expect(collectGarbage().evicted).toEqual({ GcEvictProbe: 1 });
    expect(Model.get('row')).toBeUndefined();
    Model.__applyRows?.([{ id: 'row', title: 'server' }]);
    expect(Model.get('row')).toEqual({ id: 'row', title: 'server' });
  });

  it('keeps scope members and evicts them after their scope detaches them', () => {
    setup();
    const Model = defineModel({ id: 'GcScopeProbe', name: 'GcScopeProbe', fields: { title: f.str() }, scopes: { all: scope({}) } });
    Model.scopes.all.__apply?.({}, [{ id: 'row', title: 'kept' }], 'complete');

    collectGarbage();
    expect(Model.get('row')).toBeDefined();
    Model.scopes.all.__apply?.({}, [], 'complete');
    expect(collectGarbage().evicted).toEqual({ GcScopeProbe: 1 });
    expect(Model.get('row')).toBeUndefined();
  });

  it('keeps belongsTo parents reachable from scoped children and evicts both after detachment', () => {
    setup();
    const Parent = defineModel({ id: 'GcParentProbe', name: 'GcParentProbe', fields: { title: f.str() } });
    const Child = defineModel({
      id: 'GcChildProbe',
      name: 'GcChildProbe',
      fields: { parentId: f.id() },
      relations: () => ({ parent: belongsTo(Parent, { foreignKey: 'parentId' }) }),
      scopes: { all: scope({}) }
    });
    Parent.insertStored({ id: 'parent', title: 'kept' });
    Child.scopes.all.__apply?.({}, [{ id: 'child', parentId: 'parent' }], 'complete');

    collectGarbage();
    expect(Parent.get('parent')).toBeDefined();
    expect(Child.get('child')).toBeDefined();
    Child.scopes.all.__apply?.({}, [], 'complete');
    expect(collectGarbage().evicted).toEqual({ GcParentProbe: 1, GcChildProbe: 1 });
    expect(Parent.get('parent')).toBeUndefined();
    expect(Child.get('child')).toBeUndefined();
  });

  it('keeps references targets reachable from a scoped source row', () => {
    setup();
    const Target = defineModel({ id: 'GcReferenceTarget', name: 'GcReferenceTarget', fields: { title: f.str() } });
    const Source = defineModel({
      id: 'GcReferenceSource',
      name: 'GcReferenceSource',
      fields: { refIds: f.raw<string[]>() },
      relations: () => ({ targets: references<{ refIds: string[] }, { id: string }>(Target, { ids: row => row.refIds }) }),
      scopes: { all: scope({}) }
    });
    Target.insertStored({ id: 'first', title: 'first' });
    Target.insertStored({ id: 'second', title: 'second' });
    Source.scopes.all.__apply?.({}, [{ id: 'source', refIds: ['first', 'second'] }], 'complete');

    collectGarbage();
    expect(Target.get('first')).toBeDefined();
    expect(Target.get('second')).toBeDefined();
  });

  it('keeps unscoped rows for exempt models', () => {
    setup();
    const Model = defineModel({ id: 'GcExemptProbe', name: 'GcExemptProbe', fields: { title: f.str() }, gc: 'exempt' });
    Model.insertStored({ id: 'row', title: 'kept' });

    expect(collectGarbage().evicted).not.toHaveProperty('GcExemptProbe');
    expect(Model.get('row')).toBeDefined();
  });

  it('keeps pending operation rows until the operation closes', () => {
    setup();
    const Model = defineModel({ id: 'GcPendingProbe', name: 'GcPendingProbe', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'kept' });
    getOperationState().begin({ operationId: 'gc-operation', model: 'GcPendingProbe', tempIds: ['row'], intent: 'insert', createdAt: 0 });

    collectGarbage();
    expect(Model.get('row')).toBeDefined();
    getOperationState().close('gc-operation', 'committed');
    expect(collectGarbage().evicted).toEqual({ GcPendingProbe: 1 });
    expect(Model.get('row')).toBeUndefined();
  });

  it('removes empty scope keys from memory and storage', () => {
    const { values } = setup();
    const Model = defineModel({ id: 'GcStorageScope', name: 'GcStorageScope', fields: { title: f.str() }, scopes: { all: scope({}) } });
    Model.scopes.all.__apply?.({}, [{ id: 'row', title: 'removed' }], 'complete');
    Model.scopes.all.__apply?.({}, [], 'complete');

    expect(collectGarbage().scopesRemoved).toEqual({ GcStorageScope: 1 });
    expect(Model.scopes.all.read({})).toEqual([]);
    expect(values.has('dbl:scope:GcStorageScope:__root__')).toBe(false);
  });

  it('detaches dead scope entries and then removes their empty scope', () => {
    const { values } = setup();
    values.set('dbl:scope:GcDeadScope:__root__', JSON.stringify({ generation: 1, coverage: 'complete', entries: [{ id: 'missing', order: 0, seq: 1 }] }));
    const Model = defineModel({ id: 'GcDeadScope', name: 'GcDeadScope', fields: { title: f.str() }, scopes: { all: scope({}) } });

    expect(collectGarbage().scopesRemoved).toEqual({ GcDeadScope: 1 });
    expect(Model.scopes.all.read({})).toEqual([]);
  });
});
