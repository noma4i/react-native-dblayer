import { configureDb, defineModelRuntime, f, hasMany, resetRuntime } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics, renderCounted } from '../helpers/harness';
import { act } from 'react';

const createChildModel = () =>
  defineModelRuntime({
    id: 'SpecConsumerCascadeChild',
    name: 'SpecConsumerCascadeChild',
    fields: {
      id: f.str(),
      parentId: f.str(),
      label: f.str()
    },
    scopes: {
      byParent: ({ by: { parentId: 'parentId' } })
    }
  });

const createParentModel = (childrenModel: ReturnType<typeof createChildModel>, dependentDestroy: boolean) =>
  defineModelRuntime({
    id: `SpecConsumerCascadeParent-${dependentDestroy ? 'with' : 'without'}-dependent`,
    name: `SpecConsumerCascadeParent-${dependentDestroy ? 'with' : 'without'}-dependent`,
    fields: {
      id: f.str(),
      owner: f.str(),
      name: f.str()
    },
    scopes: {
      byOwner: ({ by: { owner: 'owner' } })
    },
    relations: () => ({
      children: hasMany(childrenModel, { foreignKey: 'parentId', ...(dependentDestroy ? { dependent: 'destroy' } : {}) })
    })
  });

describe('dependent destroy relation contracts', () => {
  it('cascades dependent child destroy in one commit and removes child scope entries', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const children = createChildModel();
    const parents = createParentModel(children, true);

    parents.insert({ id: 'p-1', owner: 'viewer-1', name: 'parent' });
    children.insert({ id: 'c-1', parentId: 'p-1', label: 'child-one' });
    children.insert({ id: 'c-2', parentId: 'p-1', label: 'child-two' });

    const childReader = renderCounted(() => children.scopes.byParent.use({ parentId: 'p-1' }));
    const before = childReader.renders();

    expect(childReader.result().map(row => row.id)).toEqual(['c-1', 'c-2']);
    act(() => {
      parents.destroy('p-1');
    });

    expect(childReader.renders() - before).toBe(1);
    expect(childReader.result()).toEqual([]);
    expect(children.find('c-1')).toBeUndefined();
    expect(children.find('c-2')).toBeUndefined();
    expect(parents.find('p-1')).toBeUndefined();
    childReader.unmount();
  });

  it('cascades a multi-parent destroy with one child-model scan per relation', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const children = createChildModel();
    const parents = createParentModel(children, true);
    const parentIds = Array.from({ length: 20 }, (_, index) => `parent-${index}`);
    act(() => {
      parents.seed(parentIds.map(id => ({ id, owner: 'me', name: id })));
      children.seed(parentIds.map(id => ({ id: `child-of-${id}`, parentId: id, label: 'x' })));
    });
    diagnostics().reset();

    act(() => parents.destroyMany(parentIds));

    expect(parentIds.every(id => children.find(`child-of-${id}`) === undefined)).toBe(true);
    expect(diagnostics().snapshot().relationChildScans).toBe(1);
  });

  it('keeps non-dependent children intact when parent is destroyed', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const children = createChildModel();
    const parents = createParentModel(children, false);

    parents.insert({ id: 'p-1', owner: 'viewer-1', name: 'parent' });
    children.insert({ id: 'c-1', parentId: 'p-1', label: 'child-one' });

    const childReader = renderCounted(() => children.scopes.byParent.use({ parentId: 'p-1' }));
    const before = childReader.renders();

    expect(childReader.result().map(row => row.id)).toEqual(['c-1']);
    act(() => {
      parents.destroy('p-1');
    });

    expect(parents.find('p-1')).toBeUndefined();
    expect(childReader.renders() - before).toBe(0);
    expect(childReader.result().map(row => row.id)).toEqual(['c-1']);
    expect(children.find('c-1')).toBeDefined();
    childReader.unmount();
  });

  it('cleans cascade writes on resetRuntime right after destroy so remount shows no ghost rows', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const children = createChildModel();
    const parents = createParentModel(children, true);

    parents.insert({ id: 'p-1', owner: 'viewer-1', name: 'parent' });
    children.insert({ id: 'c-1', parentId: 'p-1', label: 'child' });
    children.insert({ id: 'c-2', parentId: 'p-1', label: 'child-two' });

    act(() => {
      parents.destroy('p-1');
    });
    resetRuntime();

    const parentReader = renderCounted(() => parents.scopes.byOwner.use({ owner: 'viewer-1' }));
    const childReader = renderCounted(() => children.scopes.byParent.use({ parentId: 'p-1' }));

    expect(parentReader.result()).toEqual([]);
    expect(childReader.result()).toEqual([]);
    expect(parents.find('p-1')).toBeUndefined();
    expect(children.find('c-1')).toBeUndefined();
    expect(children.find('c-2')).toBeUndefined();

    parentReader.unmount();
    childReader.unmount();
  });
});
