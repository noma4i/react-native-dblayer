import { act } from 'react';
import { belongsTo, configureDb, defineModel, defineShape, f, getApplyRuntime, resetRuntime, type StoragePlane } from '../../testApi';
import { createMemoryPlane, createMockTransport, renderCounted } from '../helpers/harness';

type Parent = { id: string; childCount: number };
type Child = { id: string; parentId: string };

const ParentSchema = defineShape<Parent>()({ childCount: f.num() });
const ChildSchema = defineShape<Child>()({ parentId: f.str() });

afterEach(resetRuntime);

describe('storage transaction', () => {
  it('publishes the cascade once and retries a refused cache flush', () => {
    const memory = createMemoryPlane();
    let writeCount = 0;
    let failAtWrite = Number.POSITIVE_INFINITY;
    const storage: StoragePlane = {
      get: memory.get,
      keys: memory.keys,
      set: (key, value) => {
        writeCount += 1;
        if (writeCount === failAtWrite) throw new Error('durable commit failed');
        memory.set(key, value);
      }
    };
    configureDb({ storage, transport: createMockTransport() });
    const parents = defineModel('SpecStorageTransactionParent', { schema: ParentSchema });
    const children = defineModel('SpecStorageTransactionChild', {
      schema: ChildSchema,
      associations: () => ({
        parent: belongsTo<Child, Parent>(parents, {
          foreignKey: 'parentId',
          counterCache: { field: 'childCount' }
        })
      })
    });
    parents.insert({ id: 'parent-1', childCount: 0 });
    const parentReader = renderCounted(() => parents.useFind('parent-1'));
    const childReader = renderCounted(() => children.useFind('child-1'));
    const parentRenders = parentReader.renders();
    const childRenders = childReader.renders();

    failAtWrite = writeCount + 1;
    act(() => children.insert({ id: 'child-1', parentId: 'parent-1' }));

    // The commit applies and publishes atomically in memory; the refused cache flush retries.
    expect(children.find('child-1')).toMatchObject({ parentId: 'parent-1' });
    expect(parents.find('parent-1')).toEqual({ id: 'parent-1', childCount: 1 });
    expect(parentReader.renders()).toBe(parentRenders + 1);
    expect(childReader.renders()).toBe(childRenders + 1);
    expect(() => getApplyRuntime().flushCacheSnapshots()).toThrow('durable commit failed');
    getApplyRuntime().flushCacheSnapshots();
    expect(memory.keys('dbl:row:').length).toBeGreaterThan(0);
    parentReader.unmount();
    childReader.unmount();
  });
});
