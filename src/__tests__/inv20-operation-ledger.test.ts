import { createOperationState } from '../core/planes/operationState';
import type { StoragePlane } from '../core/planes/storagePlane';
import { configureDb, flushPersistence, getOperationState } from '../dsl/configure';
import { defineModel } from '../dsl/defineModel';
import { f } from '../schema/f';

describe('inv20: operation ledger', () => {
  it('persists committed idempotency keys across hydrate', () => {
    let now = 0;
    const backing = new Map<string, string>();
    const storage: StoragePlane = {
      get: key => backing.get(key),
      set: entries => {
        for (const entry of entries) {
          if (entry.value === null) backing.delete(entry.key);
          else backing.set(entry.key, entry.value);
        }
      },
      keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
    };
    const first = createOperationState({ storage, prefix: () => 'dbl:test:', now: () => now });
    first.begin({ operationId: 'op1', model: 'm', tempIds: [], intent: 'insert', idempotencyKey: 'k1', createdAt: now });
    first.close('op1', 'committed');
    storage.set(first.persistEntries());
    const hydrated = createOperationState({ storage, prefix: () => 'dbl:test:', now: () => now });
    hydrated.hydrate();
    expect(hydrated.hasCommitted('k1')).toBe(true);
  });

  it('hasPending blocks while pending and clears on close', () => {
    const backing = new Map<string, string>();
    const storage: StoragePlane = {
      get: key => backing.get(key),
      set: entries => {
        for (const entry of entries) {
          if (entry.value === null) backing.delete(entry.key);
          else backing.set(entry.key, entry.value);
        }
      },
      keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
    };
    const state = createOperationState({ storage, prefix: () => 'dbl:test:', now: () => 0 });
    state.begin({ operationId: 'op2', model: 'm', tempIds: [], intent: 'insert', idempotencyKey: 'k2', createdAt: 0 });
    expect(state.hasPending('k2')).toBe(true);
    state.close('op2', 'rolledback');
    expect(state.hasPending('k2')).toBe(false);
    expect(state.hasCommitted('k2')).toBe(false);
  });

  it('prune drops closed operations past TTL and rebuilds indexes', () => {
    let now = 0;
    const backing = new Map<string, string>();
    const storage: StoragePlane = {
      get: key => backing.get(key),
      set: entries => {
        for (const entry of entries) {
          if (entry.value === null) backing.delete(entry.key);
          else backing.set(entry.key, entry.value);
        }
      },
      keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
    };
    const state = createOperationState({ storage, prefix: () => 'dbl:test:', now: () => now });
    state.begin({ operationId: 'op3', model: 'm', tempIds: [], intent: 'insert', idempotencyKey: 'k3', createdAt: 0 });
    state.close('op3', 'committed');
    now = 60 * 60 * 1000 + 1;
    state.prune();
    expect(state.hasCommitted('k3')).toBe(false);
  });

  it('checkpoint flush persists the operation ledger', () => {
    const backing = new Map<string, string>();
    configureDb({
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      storage: {
        get: key => backing.get(key),
        set: entries => {
          for (const entry of entries) {
            if (entry.value === null) backing.delete(entry.key);
            else backing.set(entry.key, entry.value);
          }
        },
        keys: prefix => [...backing.keys()].filter(key => key.startsWith(prefix))
      },
      defaults: { persistence: { checkpointDelayMs: 10000, maxPendingPlans: 100 } }
    });
    const Model = defineModel({ id: 'LedgerProbe', name: 'LedgerProbe', fields: { title: f.str() } });
    getOperationState().begin({ operationId: 'opX', model: 'LedgerProbe', tempIds: [], intent: 'insert', idempotencyKey: 'kx', createdAt: Date.now() });
    Model.insertStored({ id: '1', title: 't' });
    flushPersistence();
    expect(backing.has('dbl:ops')).toBe(true);
    expect(JSON.parse(backing.get('dbl:ops')!) as Record<string, unknown>).toHaveProperty('opX');
  });
});
