import { createOperationState } from '../../core/planes/operationState';
import { createMemoryStorage } from '../helpers/memoryStorage';

/*
 * C1: Operations transition from pending to committed or rolled back.
 * C2: Committed idempotency keys survive persistence and hydration.
 * C3: Closed operations expire by TTL and rebuild idempotency indexes.
 * C4: Keyed optimistic sequences are monotonic and retain their supplied floor.
 * C5: Sequence storage evicts least-recently-used keys past the cap.
 */
describe('OperationState contracts', () => {
  it('C1: pending idempotency blocks until the operation closes', () => {
    const state = createOperationState({ storage: createMemoryStorage().storage, prefix: () => 'dbl:test:', now: () => 0 });
    state.begin({ operationId: 'op', model: 'model', tempIds: [], intent: 'insert', idempotencyKey: 'key', createdAt: 0 });

    expect(state.hasPending('key')).toBe(true);
    state.close('op', 'rolledback');
    expect(state.hasPending('key')).toBe(false);
    expect(state.hasCommitted('key')).toBe(false);
  });

  it('C2: committed idempotency keys persist across hydration', () => {
    const memory = createMemoryStorage();
    const first = createOperationState({ storage: memory.storage, prefix: () => 'dbl:test:', now: () => 0 });
    first.begin({ operationId: 'op', model: 'model', tempIds: [], intent: 'insert', idempotencyKey: 'key', createdAt: 0 });
    first.close('op', 'committed');
    memory.storage.set(first.persistEntries());
    const hydrated = createOperationState({ storage: memory.storage, prefix: () => 'dbl:test:', now: () => 0 });

    hydrated.hydrate();

    expect(hydrated.hasCommitted('key')).toBe(true);
  });

  it('C3: prune removes expired closed operations and their committed keys', () => {
    let now = 0;
    const state = createOperationState({ storage: createMemoryStorage().storage, prefix: () => 'dbl:test:', now: () => now });
    state.begin({ operationId: 'op', model: 'model', tempIds: [], intent: 'insert', idempotencyKey: 'key', createdAt: now });
    state.close('op', 'committed');
    now = 60 * 60 * 1000 + 1;

    state.prune();

    expect(state.hasCommitted('key')).toBe(false);
  });

  it('C4: keyed sequences increment above their prior value and requested floor', () => {
    const state = createOperationState({ storage: createMemoryStorage().storage, prefix: () => 'dbl:test:', now: () => 0 });

    expect(state.nextSequence('chat:1', 4)).toBe(5);
    expect(state.nextSequence('chat:1', 0)).toBe(6);
    expect(state.nextSequence('chat:1', 10)).toBe(11);
  });

  it('C5: sequence persistence retains the newest 512 keyed floors', () => {
    const memory = createMemoryStorage();
    const state = createOperationState({ storage: memory.storage, prefix: () => 'dbl:test:', now: () => 0 });
    for (let index = 0; index <= 512; index += 1) state.nextSequence(`key:${index}`, 0);
    memory.storage.set(state.persistEntries());

    const sequences = JSON.parse(memory.storage.get('dbl:test:seq')!) as Record<string, number>;
    expect(Object.keys(sequences)).toHaveLength(512);
    expect(sequences['key:0']).toBeUndefined();
    expect(sequences['key:512']).toBe(1);
  });
});
