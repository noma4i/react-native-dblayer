import { createEntityClock, createEntityState } from '../../core/planes/entityState';
import { createMemoryStorage } from '../helpers/memoryStorage';

/*
 * C1: Upserts advance the entity clock and destroyed rows receive tombstones.
 * C2: Tombstones expire after their TTL without dropping younger entries for the cap.
 * C3: Cache eviction removes a row without creating a tombstone.
 * C4: Persisted rows and legacy row payloads hydrate into the canonical row-key format.
 * C5: Tombstone caps retain entries younger than the minimum safe age.
 */
describe('EntityState contracts', () => {
  it('C1: upsert and destroy advance causality while retaining the destroy marker', () => {
    const memory = createMemoryStorage();
    const state = createEntityState<{ id: string; title: string }>({ modelId: 'entity', clock: createEntityClock(), now: () => 0, storage: memory.storage, prefix: () => 'dbl:test:' });

    const captured = state.snapshot();
    state.upsert({ id: 'a', title: 'first' });
    state.destroy('a');

    expect(state.wasWrittenAfter('a', captured)).toBe(false);
    expect(state.wasDestroyedAfter('a', captured)).toBe(true);
    expect(state.isTombstoned('a')).toBe(true);
  });

  it('C2: persistence prunes tombstones older than the TTL', () => {
    let now = 0;
    const memory = createMemoryStorage();
    const state = createEntityState({ modelId: 'entity', clock: createEntityClock(), now: () => now, storage: memory.storage, prefix: () => 'dbl:test:' });
    state.upsert({ id: 'x' });
    state.destroy('x');
    now = 24 * 60 * 60 * 1000 + 1;

    const entries = state.persistEntries();
    expect(entries[1]).toEqual({ key: 'dbl:test:tombstones:entity', value: null });
    expect(state.isTombstoned('x')).toBe(false);
  });

  it('C3: eviction accepts a later server snapshot because it creates no tombstone', () => {
    const memory = createMemoryStorage();
    const state = createEntityState({ modelId: 'entity', clock: createEntityClock(), now: () => 0, storage: memory.storage, prefix: () => 'dbl:test:' });
    state.upsert({ id: 'x' });

    expect(state.evict('x')).toBe(true);
    expect(state.isTombstoned('x')).toBe(false);
    state.upsert({ id: 'x' });
    expect(state.read('x')).toEqual({ id: 'x' });
  });

  it('C4: hydration migrates legacy collection rows into per-row storage', () => {
    const memory = createMemoryStorage([['dbl:test:rows:entity', JSON.stringify([{ id: 'seed', title: 'hydrated' }])]]);
    const state = createEntityState<{ id: string; title: string }>({ modelId: 'entity', clock: createEntityClock(), now: () => 0, storage: memory.storage, prefix: () => 'dbl:test:' });

    state.hydrate();

    expect(state.read('seed')).toEqual({ id: 'seed', title: 'hydrated' });
    expect(memory.values.get('dbl:test:row:entity:seed')).toBe(JSON.stringify({ id: 'seed', title: 'hydrated' }));
    expect(memory.values.has('dbl:test:rows:entity')).toBe(false);
  });

  it('C5: cap pruning never drops tombstones younger than the minimum safe age', () => {
    let now = 0;
    const memory = createMemoryStorage();
    const state = createEntityState({ modelId: 'entity', clock: createEntityClock(), now: () => now, storage: memory.storage, prefix: () => 'dbl:test:' });
    for (let index = 0; index <= 10000; index += 1) {
      state.destroy(String(index));
    }

    state.persistEntries();

    expect(state.isTombstoned('0')).toBe(true);
    expect(state.isTombstoned('10000')).toBe(true);
  });

  it('C6: an identical upsert preserves row identity and produces no dirty entry', () => {
    const state = createEntityState<{ id: string; title: string }>({ modelId: 'entity', clock: createEntityClock(), now: () => 0, storage: createMemoryStorage().storage, prefix: () => 'dbl:test:' });
    const row = { id: 'same', title: 'same' };
    state.upsert(row);
    state.persistEntries();

    const result = state.upsert({ id: 'same', title: 'same' });
    expect(state.read('same')).toBe(row);
    expect(result.changedFields).toEqual([]);
    expect(state.persistEntries()).toEqual([]);
  });
});
