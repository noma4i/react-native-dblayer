import { compositeKey, createScopeIndex } from '../../testApi';
import { createMemoryPlane } from '../helpers/harness';

const SCOPE = compositeKey('byBucket', '{"bucket":"a"}');

const createIndex = (tag: string) => createScopeIndex({ modelId: `SpecScopeProjections${tag}`, storage: createMemoryPlane(), prefix: () => 'dbl:' });

/**
 * Owner contract of the scope index projections. `memberSets`, `keysByRow` and `orderRevisions` are
 * all derived from the committed entries, so each case drives one mutating path and then asks a
 * projection the same question the reader asks. A projection maintained by the append path but
 * repaired only by the diffing path, or one that survives a reset while its siblings are cleared,
 * answers for data that is no longer there.
 */
describe('scope index projections', () => {
  it('reports the same membership whichever path landed the rows', () => {
    const index = createIndex('Paths');
    index.write(SCOPE, index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }]).next);
    index.applyDelta(SCOPE, [{ id: 'row-2', orderKey: 'b' }], []);

    expect(index.has(SCOPE, 'row-1')).toBe(true);
    expect(index.has(SCOPE, 'row-2')).toBe(true);
    expect(index.keysOf('row-2')).toEqual([SCOPE]);
  });

  it('drops a row from both projections when a later commit no longer carries it', () => {
    const index = createIndex('Drop');
    index.applyDelta(SCOPE, [{ id: 'row-1', orderKey: 'a' }, { id: 'row-2', orderKey: 'b' }], []);

    index.write(SCOPE, index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }]).next);

    expect(index.has(SCOPE, 'row-2')).toBe(false);
    expect(index.keysOf('row-2')).toEqual([]);
  });

  it('starts the order revision from scratch after a reset', () => {
    const index = createIndex('Reset');
    index.write(SCOPE, index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }]).next);
    index.applyDelta(SCOPE, [{ id: 'row-2', orderKey: 'b' }], []);
    expect(index.orderRevision(SCOPE)).toBeGreaterThan(0);

    index.reset();

    expect(index.orderRevision(SCOPE)).toBe(0);
  });

  it('starts the order revision from scratch after a hydrate', () => {
    const index = createIndex('Hydrate');
    index.write(SCOPE, index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }]).next);
    expect(index.orderRevision(SCOPE)).toBeGreaterThan(0);

    index.hydrate();

    expect(index.orderRevision(SCOPE)).toBe(0);
  });
});
