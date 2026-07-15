import { createScopeIndex } from '../../core/planes/scopeIndex';
import { createMemoryStorage } from '../helpers/memoryStorage';

/*
 * C1: Complete coverage exactly reconciles membership without destroying entity rows.
 * C2: Page and delta coverage retain existing membership; resetOrder puts the refreshed page first.
 * C3: Scope indexes expose trim, reverse membership, and O(1) membership checks.
 * C4: Hydration restores persisted scope ledgers.
 * C5: Removing a scope clears its ledger and reverse membership index.
 */
describe('ScopeIndex contracts', () => {
  it('C1: complete coverage detaches only missing members', () => {
    const index = createScopeIndex({ modelId: 'scope', storage: createMemoryStorage().storage, prefix: () => 'dbl:test:' });
    index.reconcile('feed', 'complete', [{ id: 'a' }, { id: 'b' }]);

    const result = index.reconcile('feed', 'complete', [{ id: 'b' }]);

    expect(result.detachedIds).toEqual(['a']);
    expect(index.read('feed').entries.map(entry => entry.id)).toEqual(['b']);
  });

  it('C2: page and delta coverage preserve prior pages and resetOrder places the first page first', () => {
    const index = createScopeIndex({ modelId: 'scope', storage: createMemoryStorage().storage, prefix: () => 'dbl:test:' });
    index.reconcile('feed', 'page', [{ id: 'a' }, { id: 'b' }]);
    index.reconcile('feed', 'delta', [{ id: 'c' }]);
    index.reconcile('feed', 'page', [{ id: 'n' }, { id: 'a' }, { id: 'b' }], { resetOrder: true });

    expect(index.read('feed').entries.map(entry => entry.id)).toEqual(['n', 'a', 'b', 'c']);
  });

  it('C3: trim updates the membership and reverse indexes', () => {
    const index = createScopeIndex({ modelId: 'scope', storage: createMemoryStorage().storage, prefix: () => 'dbl:test:' });
    index.reconcile('feed', 'complete', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    expect(index.trim('feed', 2)).toEqual(['c']);
    expect(index.has('feed', 'a')).toBe(true);
    expect(index.keysOf('a')).toEqual(['feed']);
    expect(index.has('feed', 'c')).toBe(false);
  });

  it('C4: persisted ledgers hydrate with their coverage and entries', () => {
    const memory = createMemoryStorage();
    const first = createScopeIndex({ modelId: 'scope', storage: memory.storage, prefix: () => 'dbl:test:' });
    first.reconcile('feed', 'page', [{ id: 'a' }]);
    memory.storage.set(first.persistEntries());
    const hydrated = createScopeIndex({ modelId: 'scope', storage: memory.storage, prefix: () => 'dbl:test:' });

    hydrated.hydrate();

    expect(hydrated.read('feed')).toMatchObject({ coverage: 'page', entries: [{ id: 'a' }] });
  });

  it('C5: remove deletes the scope and its reverse membership references', () => {
    const index = createScopeIndex({ modelId: 'scope', storage: createMemoryStorage().storage, prefix: () => 'dbl:test:' });
    index.reconcile('feed', 'complete', [{ id: 'a' }]);

    index.remove('feed');

    expect(index.keys()).toEqual([]);
    expect(index.keysOf('a')).toEqual([]);
  });
});
