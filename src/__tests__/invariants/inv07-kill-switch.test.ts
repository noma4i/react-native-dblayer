import { createJournal } from '../../core/apply/journal';
import { createEntityClock, createEntityState } from '../../core/planes/entityState';
import { createOperationState } from '../../core/planes/operationState';
import { createScopeIndex } from '../../core/planes/scopeIndex';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { resetRuntime, registerReset } from '../../core/reset';
import { configureDb } from '../../dsl/configure';

const createStorage = (): StoragePlane => {
  const values = new Map<string, string>();
  return {
    get: key => values.get(key),
    set: entries => { for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value); },
    keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
  };
};

describe('v6 invariant 07: kill switch', () => {
  it('clears durable and registered state, is idempotent, and permits a clean new write', async () => {
    const storage = createStorage();
    configureDb({
      storage,
      transport: {
        query: async <TData>() => ({ data: {} as TData }),
        mutation: async <TData>() => ({ data: {} as TData })
      }
    });
    const prefix = () => 'dbl:';
    const first = createEntityState<{ id: string }>({ modelId: 'first', clock: createEntityClock(), now: () => 0, storage, prefix });
    const second = createEntityState<{ id: string }>({ modelId: 'second', clock: createEntityClock(), now: () => 0, storage, prefix });
    const scope = createScopeIndex({ modelId: 'first', storage, prefix });
    const operations = createOperationState({ storage, prefix, now: () => 0 });
    first.upsert({ id: 'a' });
    second.upsert({ id: 'b' });
    scope.reconcile('all', 'complete', [{ id: 'a' }]);
    operations.begin({ operationId: 'op', model: 'first', tempIds: [], intent: 'insert', createdAt: 0 });
    storage.set([...first.persistEntries(), ...second.persistEntries(), ...scope.persistEntries(), ...operations.persistEntries()]);
    createJournal(storage, prefix).writePending({ epoch: 1, planHash: 'test', status: 'pending', ops: [] });
    const unregister = [registerReset(() => first.reset()), registerReset(() => second.reset()), registerReset(() => scope.reset()), registerReset(() => operations.reset())];

    await resetRuntime();
    expect(storage.keys('dbl:')).toEqual([]);
    expect(first.values()).toEqual([]);
    expect(second.values()).toEqual([]);
    expect(scope.read('all').entries).toEqual([]);
    expect(operations.get('op')).toBeUndefined();
    await expect(resetRuntime()).resolves.toBeUndefined();

    first.upsert({ id: 'new' });
    scope.reconcile('all', 'complete', [{ id: 'new' }]);
    storage.set([...first.persistEntries(), ...scope.persistEntries()]);
    expect(first.values()).toEqual([{ id: 'new' }]);
    expect(scope.read('all').entries.map(entry => entry.id)).toEqual(['new']);
    expect(storage.keys('dbl:')).not.toEqual([]);
    for (const dispose of unregister) dispose();
  });
});
