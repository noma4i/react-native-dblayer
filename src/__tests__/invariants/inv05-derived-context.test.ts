import { createV6TestRuntime } from '../helpers/v6Runtime';
import { createOperationState } from '../../core/planes/operationState';
import type { StoragePlane } from '../../core/planes/storagePlane';

describe('v6 invariant 05: derived context', () => {
  it('applies touch and counter cache writes without defeating a later server timestamp', () => {
    const runtime = createV6TestRuntime();
    runtime.applyDerivedThenServer();
    expect(runtime.parentTimestamp()).toBe('2026-07-14T00:00:02.000Z');
    expect(runtime.counter()).toBe(1);
  });
});

describe('operation state persistence', () => {
  const createStorage = (): StoragePlane => {
    const values = new Map<string, string>();
    return {
      get: key => values.get(key),
      set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
      keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
    };
  };

  it('keeps closed records and checks committed idempotency keys', () => {
    const state = createOperationState({ storage: createStorage(), prefix: () => 'dbl:test:', now: () => 0 });
    state.begin({ operationId: 'op', model: 'm', tempIds: [], intent: 'insert', idempotencyKey: 'key', createdAt: 0 });
    state.close('op', 'committed');
    expect(state.get('op')?.status).toBe('committed');
    expect(state.hasCommitted('key')).toBe(true);
  });

  it('prunes old closed records while preserving pending records', () => {
    let now = 0;
    const state = createOperationState({ storage: createStorage(), prefix: () => 'dbl:test:', now: () => now });
    state.begin({ operationId: 'closed', model: 'm', tempIds: [], intent: 'insert', createdAt: 0 });
    state.close('closed', 'committed');
    state.begin({ operationId: 'pending', model: 'm', tempIds: [], intent: 'insert', createdAt: 0 });
    now = 60 * 60 * 1000 + 1;
    expect(state.prune()).toBe(1);
    expect(state.get('pending')?.status).toBe('pending');
  });

  it('uses monotonic keyed sequences and persists them', () => {
    const storage = createStorage();
    const prefix = () => 'dbl:test:';
    const state = createOperationState({ storage, prefix, now: () => 0 });
    expect(state.nextSequence('chat', 4)).toBe(5);
    expect(state.nextSequence('chat', 1)).toBe(6);
    expect(state.nextSequence('chat', 10)).toBe(11);
    state.begin({ operationId: 'op', model: 'm', tempIds: [], intent: 'insert', createdAt: 0 });
    storage.set(state.persistEntries());
    const hydrated = createOperationState({ storage, prefix, now: () => 0 });
    hydrated.hydrate();
    expect(hydrated.get('op')).toEqual(state.get('op'));
    expect(hydrated.nextSequence('chat', 0)).toBe(12);
  });

  it('evicts cold sequence keys and restores their floor from server data', () => {
    const state = createOperationState({ storage: createStorage(), prefix: () => 'dbl:test:', now: () => 0 });
    for (let index = 0; index < 513; index += 1) state.nextSequence(`key-${index}`, 0);

    expect(state.nextSequence('key-0', 40)).toBe(41);
  });

  it('keeps a recently touched sequence key when the LRU cap evicts the oldest key', () => {
    const state = createOperationState({ storage: createStorage(), prefix: () => 'dbl:test:', now: () => 0 });
    state.nextSequence('hot', 0);
    state.nextSequence('cold', 0);
    for (let index = 0; index < 510; index += 1) state.nextSequence(`key-${index}`, 0);
    expect(state.nextSequence('hot', 0)).toBe(2);
    state.nextSequence('overflow', 0);

    expect(state.nextSequence('cold', 40)).toBe(41);
    expect(state.nextSequence('hot', 0)).toBe(3);
  });
});
