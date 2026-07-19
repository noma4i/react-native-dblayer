import { configureDb, defineModel, f, hasMany, resetRuntime, scope } from '../../../index';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';
import { act } from 'react-test-renderer';

type ParentRow = { id: string; owner: string; name: string };
type ChildRow = { id: string; parentId: string; label: string };
const createChildModel = () =>
  defineModel({
    id: 'SpecConsumerCascadeChild',
    name: 'SpecConsumerCascadeChild',
    fields: {
      id: f.str(),
      parentId: f.str(),
      label: f.str()
    },
    scopes: {
      byParent: scope<ChildRow>({ by: { parentId: 'parentId' } })
    }
  });

const createParentModel = (childrenModel: ReturnType<typeof createChildModel>, dependentDestroy: boolean) =>
  defineModel({
    id: `SpecConsumerCascadeParent-${dependentDestroy ? 'with' : 'without'}-dependent`,
    name: `SpecConsumerCascadeParent-${dependentDestroy ? 'with' : 'without'}-dependent`,
    fields: {
      id: f.str(),
      owner: f.str(),
      name: f.str()
    },
    scopes: {
      byOwner: scope<ParentRow>({ by: { owner: 'owner' } })
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

    parents.insertStored({ id: 'p-1', owner: 'viewer-1', name: 'parent' });
    children.insertStored({ id: 'c-1', parentId: 'p-1', label: 'child-one' });
    children.insertStored({ id: 'c-2', parentId: 'p-1', label: 'child-two' });

    const childReader = renderCounted(() => children.scopes.byParent.use({ parentId: 'p-1' }));
    const before = childReader.renders();

    expect(childReader.result().map(row => row.id)).toEqual(['c-1', 'c-2']);
    act(() => {
      parents.destroy('p-1');
    });

    expect(childReader.renders() - before).toBe(1);
    expect(childReader.result()).toEqual([]);
    expect(children.get('c-1')).toBeUndefined();
    expect(children.get('c-2')).toBeUndefined();
    expect(parents.get('p-1')).toBeUndefined();
    childReader.unmount();
  });

  it('keeps non-dependent children intact when parent is destroyed', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const children = createChildModel();
    const parents = createParentModel(children, false);

    parents.insertStored({ id: 'p-1', owner: 'viewer-1', name: 'parent' });
    children.insertStored({ id: 'c-1', parentId: 'p-1', label: 'child-one' });

    const childReader = renderCounted(() => children.scopes.byParent.use({ parentId: 'p-1' }));
    const before = childReader.renders();

    expect(childReader.result().map(row => row.id)).toEqual(['c-1']);
    act(() => {
      parents.destroy('p-1');
    });

    expect(parents.get('p-1')).toBeUndefined();
    expect(childReader.renders() - before).toBe(0);
    expect(childReader.result().map(row => row.id)).toEqual(['c-1']);
    expect(children.get('c-1')).toBeDefined();
    childReader.unmount();
  });

  it('cleans cascade writes on resetRuntime right after destroy so remount shows no ghost rows', () => {
    configureDb({ storage: createMemoryPlane(), transport: createMockTransport() as never });
    const children = createChildModel();
    const parents = createParentModel(children, true);

    parents.insertStored({ id: 'p-1', owner: 'viewer-1', name: 'parent' });
    children.insertStored({ id: 'c-1', parentId: 'p-1', label: 'child' });
    children.insertStored({ id: 'c-2', parentId: 'p-1', label: 'child-two' });

    act(() => {
      parents.destroy('p-1');
    });
    resetRuntime();

    const parentReader = renderCounted(() => parents.scopes.byOwner.use({ owner: 'viewer-1' }));
    const childReader = renderCounted(() => children.scopes.byParent.use({ parentId: 'p-1' }));

    expect(parentReader.result()).toEqual([]);
    expect(childReader.result()).toEqual([]);
    expect(parents.get('p-1')).toBeUndefined();
    expect(children.get('c-1')).toBeUndefined();
    expect(children.get('c-2')).toBeUndefined();

    parentReader.unmount();
    childReader.unmount();
  });
});
