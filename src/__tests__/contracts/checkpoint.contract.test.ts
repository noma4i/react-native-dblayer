import { flushPersistence, getOperationState } from '../../dsl/configure';
import { createCheckpointScheduler } from '../../core/apply/checkpoint';
import { defineModel } from '../../dsl/defineModel';
import { f } from '../../schema/f';
import { createContractScenario } from '../helpers/contractScenario';
import { createMemoryStorage } from '../helpers/memoryStorage';

/*
 * C1: A forced checkpoint persists dirty model snapshots and the operation ledger in one batch.
 * C2: A clean checkpoint does not issue another storage write.
 * C3: The pending-plan cap flushes snapshots before markers and checkpoint metadata.
 * C4: Debounce defers a checkpoint until its timer elapses.
 * C5: A torn checkpoint with a snapshot but no applied marker replays safely on restart.
 */
describe('Checkpoint contracts', () => {
  it('C1: flush persists dirty snapshots and operation records', () => {
    const scenario = createContractScenario({ persistence: { checkpointDelayMs: 10000, maxPendingPlans: 100 } });
    const Model = defineModel({ id: 'CheckpointContract', name: 'CheckpointContract', fields: { title: f.str() } });
    getOperationState().begin({ operationId: 'op', model: 'CheckpointContract', tempIds: [], intent: 'insert', idempotencyKey: 'key', createdAt: 0 });
    Model.insertStored({ id: 'row', title: 'persisted' });

    flushPersistence();

    expect(scenario.values.has('dbl:ops')).toBe(true);
    expect(scenario.values.get('dbl:row:CheckpointContract:row')).toBe(JSON.stringify({ id: 'row', title: 'persisted' }));
  });

  it('C2: a second forced flush without a new plan performs no persistence batch', () => {
    const scenario = createContractScenario({ persistence: { checkpointDelayMs: 10000, maxPendingPlans: 100 } });
    const Model = defineModel({ id: 'CleanCheckpointContract', name: 'CleanCheckpointContract', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'persisted' });
    flushPersistence();
    const batches = scenario.counters.setBatches;

    flushPersistence();

    expect(scenario.counters.setBatches).toBe(batches);
  });

  it('C3: the maxPendingPlans cap flushes snapshots before applied markers and metadata', () => {
    const memory = createMemoryStorage();
    const scheduler = createCheckpointScheduler({
      storage: memory.storage,
      prefix: () => 'dbl:',
      getTarget: () => ({ persistEntries: () => [{ key: 'dbl:row:checkpoint:row', value: 'snapshot' }] }),
      delayMs: 100000,
      maxPendingPlans: 1
    });

    scheduler.notePlan(['checkpoint'], 7);

    const entries = [...memory.values.keys()];
    expect(entries).toEqual(['dbl:row:checkpoint:row', 'dbl:applied:checkpoint', 'dbl:meta']);
    expect(memory.values.get('dbl:meta')).toBe(JSON.stringify({ lastCheckpointEpoch: 7 }));
    expect(scheduler.flushedEpoch()).toBe(7);
  });

  it('C4: debounce keeps snapshots out of storage until the configured delay', () => {
    jest.useFakeTimers();
    try {
      const memory = createMemoryStorage();
      const scheduler = createCheckpointScheduler({
        storage: memory.storage,
        prefix: () => 'dbl:',
        getTarget: () => ({ persistEntries: () => [{ key: 'dbl:row:checkpoint:row', value: 'snapshot' }] }),
        delayMs: 25,
        maxPendingPlans: 2
      });
      scheduler.notePlan(['checkpoint'], 1);

      expect(memory.values).toEqual(new Map());
      jest.advanceTimersByTime(25);
      expect(memory.values.get('dbl:row:checkpoint:row')).toBe('snapshot');
      scheduler.cancel();
    } finally {
      jest.useRealTimers();
    }
  });

  it('C5: a persisted snapshot without its applied marker survives replay after restart', async () => {
    const scenario = createContractScenario({ persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } });
    const Model = defineModel({ id: 'TornCheckpointContract', name: 'TornCheckpointContract', fields: { title: f.str() } });
    Model.insertStored({ id: 'row', title: 'snapshot' });
    scenario.storage.set([{ key: 'dbl:row:TornCheckpointContract:row', value: JSON.stringify({ id: 'row', title: 'snapshot' }) }]);

    jest.resetModules();
    const configureModule = await import('../../dsl/configure');
    const modelModule = await import('../../dsl/defineModel');
    const schemaModule = await import('../../schema/f');
    configureModule.configureDb({
      storage: scenario.storage,
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } }
    });
    const restarted = modelModule.defineModel({ id: 'TornCheckpointContract', name: 'TornCheckpointContract', fields: { title: schemaModule.f.str() } });

    expect(restarted.get('row')).toEqual({ id: 'row', title: 'snapshot' });
    expect(configureModule.replayJournal()).toBeGreaterThan(0);
    expect(restarted.getAll()).toEqual([{ id: 'row', title: 'snapshot' }]);
  });
});
