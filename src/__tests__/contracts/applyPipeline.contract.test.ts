import type { JournalRecord } from '../../core/apply/journal';
import { flushPersistence, getCommitBus, purgeForeignStorageKeys, replayJournal } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';
import { createContractScenario } from '../helpers/contractScenario';

/*
 * C1: Durable journal records replay applied but uncheckpointed plans exactly once after restart.
 * C2: The hot path never enumerates journal keys and records scope deltas instead of full scopes.
 * C3: Destroying an unseen id is silent but blocks stale snapshots through a tombstone.
 * C4: Auto-membership is visible in the same transaction as an event write.
 * C5: Storage keys outside the namespace are purged only by explicit startup housekeeping.
 * C6: Covered pending journal records become committed during replay.
 */
describe('Apply pipeline contracts', () => {
  it('C1: replay restores an uncheckpointed journal plan after a module restart', async () => {
    const scenario = createContractScenario({ persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } });
    const Model = defineModel({ id: 'ReplayContract', name: 'ReplayContract', fields: { title: f.str() } });
    Model.insertStored({ id: 'r1', title: 'unflushed' });

    jest.resetModules();
    const configureModule = await import('../../dsl/configure');
    const modelModule = await import('../../dsl/defineModel');
    const schemaModule = await import('../../schema/f');
    configureModule.configureDb({
      storage: scenario.storage,
      transport: { query: async <TData>() => ({ data: {} as TData }), mutation: async <TData>() => ({ data: {} as TData }) },
      defaults: { persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } }
    });
    const restarted = modelModule.defineModel({ id: 'ReplayContract', name: 'ReplayContract', fields: { title: schemaModule.f.str() } });

    expect(restarted.get('r1')).toBeUndefined();
    expect(configureModule.replayJournal()).toBeGreaterThan(0);
    expect(restarted.get('r1')).toEqual({ id: 'r1', title: 'unflushed' });
    configureModule.replayJournal();
    expect(restarted.getAll()).toEqual([{ id: 'r1', title: 'unflushed' }]);
  });

  it('C1: a plan writes its pending journal record before its committed journal record', () => {
    const scenario = createContractScenario({ persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } });
    const writes: Array<Array<{ key: string; value: string | null }>> = [];
    const set = scenario.storage.set;
    scenario.storage.set = entries => {
      writes.push(entries);
      set(entries);
    };
    const Model = defineModel({ id: 'WalOrderContract', name: 'WalOrderContract', fields: { title: f.str() } });

    Model.insertStored({ id: 'row', title: 'written' });

    const journalWrites = writes.filter(entries => entries.some(entry => entry.key.startsWith('dbl:journal:')));
    expect(JSON.parse(journalWrites[0]![0]!.value!)).toMatchObject({ status: 'pending' });
    expect(JSON.parse(journalWrites[1]![0]!.value!)).toMatchObject({ status: 'committed' });
  });

  it('C2: hot writes journal a scope delta without scanning the journal namespace', () => {
    const scenario = createContractScenario({ persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } });
    const keysCalls: string[] = [];
    const originalKeys = scenario.storage.keys;
    scenario.storage.keys = prefix => {
      keysCalls.push(prefix);
      return originalKeys(prefix);
    };
    const Model = defineModel({ id: 'ApplyContract', name: 'ApplyContract', fields: { chatId: f.id() }, scopes: { thread: scope({ by: { chatId: 'chatId' } }) } });
    for (let index = 1; index <= 100; index += 1) Model.insertStored({ id: `m${index}`, chatId: 'c1' });
    const before = keysCalls.filter(prefix => prefix.includes('journal:')).length;
    Model.insertStored({ id: 'fresh', chatId: 'c1' });
    const afterWrite = keysCalls.filter(prefix => prefix.includes('journal:')).length;
    const journalKey = scenario.storage
      .keys('dbl:journal:')
      .map(key => ({ key, epoch: Number(key.split(':').at(-1)) }))
      .sort((left, right) => right.epoch - left.epoch)[0]!.key;
    const record = JSON.parse(scenario.storage.get(journalKey)!) as JournalRecord;

    expect(afterWrite).toBe(before);
    expect(record.ops.some(op => op.kind === 'scope-delta' && op.append.length === 1 && op.append[0]!.id === 'fresh')).toBe(true);
    expect(JSON.stringify(record)).not.toContain('"m50"');
  });

  it('C2: journal pruning keeps the committed record count within its cap after a checkpoint', () => {
    const scenario = createContractScenario({ persistence: { checkpointDelayMs: 100000, maxPendingPlans: 100000 } });
    const Model = defineModel({ id: 'JournalCapContract', name: 'JournalCapContract', fields: { title: f.str() } });
    for (let index = 0; index <= 50; index += 1) Model.insertStored({ id: String(index), title: String(index) });
    flushPersistence();
    Model.insertStored({ id: 'latest', title: 'latest' });

    expect(scenario.storage.keys('dbl:journal:')).toHaveLength(50);
  });

  it('C3: destroy of an unseen id emits no change and rejects a stale snapshot', () => {
    createContractScenario();
    const Model = defineModel({ id: 'SilentDestroyContract', name: 'SilentDestroyContract', fields: { chatId: f.id() } });
    const notify = jest.fn();
    const subscription = getCommitBus().subscribe(notify, [{ kind: 'model', model: 'SilentDestroyContract' }]);

    Model.destroy('ghost');
    Model.__applyRows?.([{ id: 'ghost', chatId: 'c1' }]);

    expect(notify).not.toHaveBeenCalled();
    expect(Model.get('ghost')).toBeUndefined();
    subscription.unsubscribe();
  });

  it('C4: event insertion joins matching membership before the caller observes the model', () => {
    createContractScenario();
    const Model = defineModel({ id: 'MembershipContract', name: 'MembershipContract', fields: { chatId: f.id() }, scopes: { thread: scope({ by: { chatId: 'chatId' } }) } });

    Model.insertStored({ id: 'tick', chatId: 'c9' });

    expect(Model.scopes.thread.read({ chatId: 'c9' }).map(row => row.id)).toEqual(['tick']);
  });

  it('C5: explicit startup housekeeping removes pre-v6 keys without touching dbl keys', () => {
    const scenario = createContractScenario();
    scenario.storage.set([
      { key: 'moments:1', value: 'legacy-row' },
      { key: 'freshness:moments:x', value: 'legacy-freshness' },
      { key: 'dbl:journal', value: 'live-journal' }
    ]);
    expect(purgeForeignStorageKeys()).toBe(2);
    expect(scenario.storage.get('moments:1')).toBeUndefined();
    expect(scenario.storage.get('freshness:moments:x')).toBeUndefined();
    expect(scenario.storage.get('dbl:journal')).toBe('live-journal');
  });

  it('C6: replay commits a pending record already covered by an applied marker', () => {
    const scenario = createContractScenario();
    defineModel({ id: 'ZombieJournalContract', name: 'ZombieJournalContract', fields: { title: f.str() } });
    scenario.storage.set([
      { key: 'dbl:journal:1', value: JSON.stringify({ epoch: 1, status: 'pending', ops: [{ kind: 'upsert', model: 'ZombieJournalContract', rows: [{ id: 'row', title: 'covered' }] }] }) },
      { key: 'dbl:applied:ZombieJournalContract', value: '1' }
    ]);

    expect(replayJournal()).toBe(0);
    expect(JSON.parse(scenario.storage.get('dbl:journal:1')!) as JournalRecord).toMatchObject({ status: 'committed' });
    expect(replayJournal()).toBe(0);
  });
});
