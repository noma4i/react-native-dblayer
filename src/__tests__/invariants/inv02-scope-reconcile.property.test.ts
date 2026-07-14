import fc from 'fast-check';
import { createV6TestRuntime } from '../helpers/v6Runtime';
import { createScopeIndex } from '../../core/planes/scopeIndex';
import type { StoragePlane } from '../../core/planes/storagePlane';

describe('v6 invariant 02: scope reconcile', () => {
  it('only detaches missing membership for complete coverage', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('complete', 'page', 'delta'),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 8 }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 8 }),
        (coverage, current, incoming) => {
          const runtime = createV6TestRuntime({ current });
          runtime.reconcile(coverage, incoming);
          expect(runtime.scopeIds()).toEqual(coverage === 'complete' ? incoming : [...current, ...incoming.filter(id => !current.includes(id))]);
          expect(runtime.destroyedIds()).toEqual([]);
        }
      )
    );
  });
});

describe('scope index persistence and reconciliation', () => {
  const createStorage = (): StoragePlane => {
    const values = new Map<string, string>();
    return {
      get: key => values.get(key),
      set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
      keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
    };
  };

  it('uses server order for complete coverage and reports detached ids', () => {
    const storage = createStorage();
    const index = createScopeIndex({ modelId: 'm', storage, prefix: () => 'dbl:test:' });
    index.reconcile('scope', 'complete', [{ id: 'a' }, { id: 'b' }]);
    const result = index.reconcile('scope', 'complete', [{ id: 'b' }, { id: 'c' }]);
    expect(result.next.entries.map(entry => entry.id)).toEqual(['b', 'c']);
    expect(result.detachedIds).toEqual(['a']);
  });

  it('keeps existing page order, appends new rows, and updates edges', () => {
    const storage = createStorage();
    const index = createScopeIndex({ modelId: 'm', storage, prefix: () => 'dbl:test:' });
    index.reconcile('scope', 'complete', [{ id: 'a', edge: { rank: 1 } }, { id: 'b' }]);
    const result = index.reconcile('scope', 'page', [{ id: 'a', edge: { rank: 2 } }, { id: 'c', edge: { rank: 3 } }]);
    expect(result.next.entries.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
    expect(result.next.entries[0].edge).toEqual({ rank: 2 });
    expect(result.next.entries[2].edge).toEqual({ rank: 3 });
    expect(result.detachedIds).toEqual([]);
  });

  it('trims trailing ids and hydrates persisted scopes', () => {
    const storage = createStorage();
    const prefix = () => 'dbl:test:';
    const index = createScopeIndex({ modelId: 'm', storage, prefix });
    index.reconcile('scope', 'complete', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(index.trim('scope', 2)).toEqual(['c']);
    storage.set(index.persistEntries());
    const hydrated = createScopeIndex({ modelId: 'm', storage, prefix });
    hydrated.hydrate();
    expect(hydrated.read('scope')).toEqual(index.read('scope'));
  });
});
