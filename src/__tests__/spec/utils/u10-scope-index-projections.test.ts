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

  it('holds no reverse entry for a row that left its last scope', () => {
    const index = createIndex('Reverse');
    index.applyDelta(SCOPE, [{ id: 'row-1', orderKey: 'a' }, { id: 'row-2', orderKey: 'b' }], []);
    expect(index.residentRowKeys()).toBe(2);

    // The scope survives, so only the departed row's reverse entry may go - and it must go.
    index.write(SCOPE, index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }]).next);

    expect(index.residentRowKeys()).toBe(1);
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

  it('keeps protected members when a complete snapshot omits them', () => {
    const index = createIndex('ProtectedSnapshot');
    index.write(SCOPE, index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }, { id: 'row-2' }]).next);

    const result = index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }], { protectedIds: new Set(['row-2']) });

    expect(result.detachedIds).toEqual([]);
    expect(result.next.entries.map(entry => entry.id)).toEqual(['row-1', 'row-2']);
  });

  it('excludes protected members from the trim budget', () => {
    const index = createIndex('ProtectedTrim');
    const value = index.reconcileNext(SCOPE, 'complete', [{ id: 'row-1' }, { id: 'row-2' }, { id: 'row-3' }]).next;
    const protectedIds = new Set(['row-1']);

    const trimmed = index.trimValue(value, 1, protectedIds);

    expect(trimmed.next.entries.map(entry => entry.id)).toEqual(['row-1', 'row-2']);
    expect(trimmed.trimmedIds).toEqual(['row-3']);
    expect(index.trimValue(value, 0, new Set(['row-1', 'row-2', 'row-3']))).toEqual({ next: value, trimmedIds: [] });
  });

  it('records scope access independently from persisted membership', () => {
    const index = createIndex('Access');
    const now = jest.spyOn(Date, 'now').mockReturnValue(1234);

    expect(index.lastAccess(SCOPE)).toBeUndefined();
    index.noteAccess(SCOPE);
    expect(index.lastAccess(SCOPE)).toBe(1234);

    now.mockRestore();
  });

  it('serializes the complete staged overlay without publishing it', () => {
    const index = createIndex('StagedPersistence');
    const untouched = compositeKey('byBucket', '{"bucket":"untouched"}');
    const removed = compositeKey('byBucket', '{"bucket":"removed"}');
    const added = compositeKey('byBucket', '{"bucket":"added"}');
    index.write(untouched, index.reconcileNext(untouched, 'complete', [{ id: 'row-1' }]).next);
    index.write(removed, index.reconcileNext(removed, 'complete', [{ id: 'row-2' }]).next);

    index.beginApply();
    index.remove(removed);
    index.write(added, index.reconcileNext(added, 'complete', [{ id: 'row-3' }]).next);
    const persisted = index.persistEntries();

    expect(persisted).toHaveLength(3);
    expect(persisted.find(entry => entry.key.includes(untouched))?.value).toEqual(expect.any(String));
    expect(persisted.find(entry => entry.key.includes(removed))?.value).toBeNull();
    expect(persisted.find(entry => entry.key.includes(added))?.value).toEqual(expect.any(String));
    expect(index.keysOf('row-3')).toEqual([]);

    index.abortApply();
  });
});
