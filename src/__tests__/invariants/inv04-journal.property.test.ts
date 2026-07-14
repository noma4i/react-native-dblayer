import fc from 'fast-check';
import { createV6TestRuntime } from '../helpers/v6Runtime';
import { createCommitBus } from '../../core/apply/commitBus';
import { createJournal } from '../../core/apply/journal';
import { createApplyRuntime, registerApplyTarget } from '../../core/apply/transaction';
import type { StoragePlane } from '../../core/planes/storagePlane';

describe('v6 invariant 04: journal replay', () => {
  it('converges exactly once after every durable-commit interruption point', () => {
    fc.assert(
      fc.property(fc.constantFrom('before', 'during', 'after'), interruption => {
        const runtime = createV6TestRuntime();
        const expected = runtime.applyThenRestart(interruption);
        expect(runtime.snapshot()).toEqual(expected);
      })
    );
  });
});

describe('journalled transactions', () => {
  const createStorage = (batches: Array<Array<{ key: string; value: string | null }>> = []): StoragePlane => {
    const values = new Map<string, string>();
    return {
      get: key => values.get(key),
      set: entries => {
        batches.push(entries);
        for (const entry of entries) entry.value === null ? values.delete(entry.key) : values.set(entry.key, entry.value);
      },
      keys: prefix => [...values.keys()].filter(key => key.startsWith(prefix))
    };
  };

  it('writes pending before applying and commits at the next epoch', () => {
    const batches: Array<Array<{ key: string; value: string | null }>> = [];
    const storage = createStorage(batches);
    const prefix = () => 'dbl:test:';
    const observedStatuses: string[] = [];
    const unregister = registerApplyTarget('m', {
      upsert: rows => {
        observedStatuses.push(JSON.parse(storage.get('dbl:test:journal:1')!).status);
        return rows.map(row => ({ id: (row as { id: string }).id, changedFields: null }));
      },
      patch: () => null,
      destroy: ids => ids,
      counter: () => false,
      scope: () => {},
      persistEntries: () => []
    });
    const runtime = createApplyRuntime({ storage, prefix, bus: createCommitBus() });
    runtime.apply([{ kind: 'upsert', model: 'm', rows: [{ id: '1' }] }]);
    expect(observedStatuses).toEqual(['pending']);
    expect(JSON.parse(storage.get('dbl:test:journal:1')!).status).toBe('committed');
    expect(batches.map(entries => entries.map(entry => entry.key))).toEqual([
      ['dbl:test:journal:1'],
      ['dbl:test:applied:m', 'dbl:test:journal:1']
    ]);
    expect(runtime.currentEpoch()).toBe(1);
    unregister();
  });

  it('replays a pending record exactly once and marks it committed', () => {
    const storage = createStorage();
    const prefix = () => 'dbl:test:';
    createJournal(storage, prefix).writePending({ epoch: 1, planHash: 'plan', status: 'pending', ops: [{ kind: 'upsert', model: 'm', rows: [{ id: '1' }] }] });
    let applied = 0;
    const unregister = registerApplyTarget('m', {
      upsert: rows => { applied += 1; return rows.map(row => ({ id: (row as { id: string }).id, changedFields: null })); },
      patch: () => null,
      destroy: ids => ids,
      counter: () => false,
      scope: () => {},
      persistEntries: () => []
    });
    const runtime = createApplyRuntime({ storage, prefix, bus: createCommitBus() });
    expect(runtime.replay()).toBe(1);
    expect(runtime.replay()).toBe(0);
    expect(applied).toBe(1);
    expect(JSON.parse(storage.get('dbl:test:journal:1')!).status).toBe('committed');
    expect(storage.get('dbl:test:applied:m')).toBe('1');
    unregister();
  });

  it('caps committed records at fifty', () => {
    const storage = createStorage();
    const runtime = createApplyRuntime({ storage, prefix: () => 'dbl:test:', bus: createCommitBus() });
    for (let index = 0; index < 51; index += 1) runtime.apply([]);
    expect(storage.keys('dbl:test:journal:')).toHaveLength(50);
  });
});
