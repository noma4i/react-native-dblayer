import fc from 'fast-check';
import { createV6TestRuntime } from '../helpers/v6Runtime';
import { createEntityClock, createEntityState } from '../../core/planes/entityState';
import type { StoragePlane } from '../../core/planes/storagePlane';

describe('v6 invariant 01: interleavings', () => {
  it('preserves tombstones, post-capture writes, counters, and operation closure', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('initial', 'page', 'sub-upsert', 'sub-destroy', 'optimistic', 'commit', 'rollback', 're-delivery'), { minLength: 1, maxLength: 80 }),
        operations => {
          const runtime = createV6TestRuntime();
          runtime.run([...operations, 'commit']);
          expect(runtime.assertInvariants()).toEqual([]);
        }
      )
    );
  });
});

describe('entity state persistence and tombstones', () => {
  const createStorage = (): StoragePlane => {
    const values = new Map<string, string>();
    return {
      get: key => values.get(key),
      set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
      keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
    };
  };

  it('reports only changed top-level fields and null for new rows', () => {
    const state = createEntityState<{ id: string; name?: string; age?: number }>({ modelId: 'm', clock: createEntityClock(), now: () => 0, storage: createStorage(), prefix: () => 'dbl:test:' });
    expect(state.upsert({ id: '1', name: 'A', age: 1 }).changedFields).toBeNull();
    expect(state.upsert({ id: '1', name: 'B', age: 1 }).changedFields).toEqual(['name']);
  });

  it('records tombstones relative to captures', () => {
    const state = createEntityState<{ id: string }>({ modelId: 'm', clock: createEntityClock(), now: () => 0, storage: createStorage(), prefix: () => 'dbl:test:' });
    state.upsert({ id: '1' });
    const capture = state.snapshot();
    state.destroy('1');
    expect(state.isTombstoned('1')).toBe(true);
    expect(state.wasDestroyedAfter('1', capture)).toBe(true);
  });

  it('prunes expired tombstones and applies the cap only after the minimum age', () => {
    let now = 0;
    const state = createEntityState<{ id: string }>({ modelId: 'm', clock: createEntityClock(), now: () => now, storage: createStorage(), prefix: () => 'dbl:test:' });
    state.destroy('expired');
    now = 24 * 60 * 60 * 1000 + 1;
    expect(state.pruneTombstones()).toBe(1);
    now = 1_000;
    for (let index = 0; index < 10_001; index += 1) state.destroy(`id:${index}`);
    expect(state.pruneTombstones()).toBe(0);
    now = 10 * 60 * 1000 + 2_000;
    expect(state.pruneTombstones()).toBe(1);
  });

  it('round trips persisted rows and tombstones', () => {
    const storage = createStorage();
    const prefix = () => 'dbl:test:';
    const state = createEntityState<{ id: string; name?: string }>({ modelId: 'm', clock: createEntityClock(), now: () => 0, storage, prefix });
    state.upsert({ id: '1', name: 'A' });
    state.destroy('2');
    storage.set(state.persistEntries());
    const hydrated = createEntityState<{ id: string; name?: string }>({ modelId: 'm', clock: createEntityClock(), now: () => 0, storage, prefix });
    hydrated.hydrate();
    expect(hydrated.read('1')).toEqual({ id: '1', name: 'A' });
    expect(hydrated.isTombstoned('2')).toBe(true);
  });

  it('migrates legacy rows and persists only dirty row entries', () => {
    const storage = createStorage();
    const prefix = () => 'dbl:';
    storage.set([{ key: 'dbl:rows:m', value: JSON.stringify([{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]) }]);

    const state = createEntityState<{ id: string; name?: string }>({ modelId: 'm', clock: createEntityClock(), now: () => 0, storage, prefix });
    state.hydrate();

    expect(state.read('one')).toEqual({ id: 'one', name: 'One' });
    expect(state.read('two')).toEqual({ id: 'two', name: 'Two' });
    expect(storage.keys('dbl:row:m:').sort()).toEqual(['dbl:row:m:one', 'dbl:row:m:two']);
    expect(storage.get('dbl:rows:m')).toBeUndefined();

    state.upsert({ id: 'one', name: 'Updated' });
    expect(state.persistEntries()).toEqual([{ key: 'dbl:row:m:one', value: JSON.stringify({ id: 'one', name: 'Updated' }) }]);

    state.destroy('one');
    expect(state.persistEntries()).toEqual([
      { key: 'dbl:row:m:one', value: null },
      { key: 'dbl:tombstones:m', value: expect.any(String) }
    ]);
  });
});
