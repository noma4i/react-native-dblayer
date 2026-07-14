import type { JournalRecord } from '../../core/apply/journal';
import type { StoragePlane } from '../../core/planes/storagePlane';
import { getCommitBus, configureDb } from '../../dsl/configure';
import { defineModel } from '../../dsl/defineModel';
import { scope } from '../../dsl/scope';
import { f } from '../../schema/f';

const createStorage = (): { storage: StoragePlane; keysCalls: string[] } => {
  const values = new Map<string, string>();
  const keysCalls: string[] = [];
  return {
    storage: {
      get: key => values.get(key),
      set: entries => {
        for (const entry of entries) {
          if (entry.value === null) values.delete(entry.key);
          else values.set(entry.key, entry.value);
        }
      },
      keys: prefix => {
        keysCalls.push(prefix);
        return [...values.keys()].filter(key => key.startsWith(prefix));
      }
    },
    keysCalls
  };
};

const setup = () => {
  const { storage, keysCalls } = createStorage();
  configureDb({
    storage,
    transport: {
      query: async <TData>() => ({ data: {} as TData }),
      mutation: async <TData>() => ({ data: {} as TData })
    },
    defaults: { persistence: { checkpointDelayMs: 100_000, maxPendingPlans: 100_000 } }
  });
  const Model = defineModel({
    id: 'Msg',
    name: 'Msg',
    fields: { chatId: f.id() },
    scopes: { thread: scope({ by: { chatId: 'chatId' } }) }
  });
  return { Model, storage, keysCalls };
};

describe('perf 04: journal hot path', () => {
  it('apply does not enumerate journal keys on the hot path', () => {
    const { Model, keysCalls } = setup();
    Model.insertStored({ id: 'w1', chatId: 'c1' });
    const keysCallsAfterFirstApply = keysCalls.filter(prefix => prefix.includes('journal:')).length;
    Model.insertStored({ id: 'w2', chatId: 'c1' });
    Model.insertStored({ id: 'w3', chatId: 'c1' });

    expect(keysCalls.filter(prefix => prefix.includes('journal:')).length).toBe(keysCallsAfterFirstApply);
  });

  it('membership journals a delta, not the full scope', () => {
    const { Model, storage } = setup();
    for (let index = 1; index <= 100; index += 1) Model.insertStored({ id: `m${index}`, chatId: 'c1' });
    Model.insertStored({ id: 'fresh', chatId: 'c1' });
    const journalKey = storage
      .keys('dbl:journal:')
      .map(key => ({ key, epoch: Number(key.split(':').at(-1)) }))
      .sort((a, b) => b.epoch - a.epoch)[0]!.key;
    const record = JSON.parse(storage.get(journalKey)!) as JournalRecord;

    expect('planHash' in record).toBe(false);
    expect(record.ops.some(op => op.kind === 'scope-delta' && op.append.length === 1 && op.append[0]!.id === 'fresh')).toBe(true);
    expect(record.ops.every(op => op.kind !== 'scope')).toBe(true);
    expect(JSON.stringify(record)).not.toContain('"m50"');
  });

  it('destroy of an unseen id stays silent but still tombstones', () => {
    const { Model } = setup();
    const notify = jest.fn();
    const subscription = getCommitBus().subscribe(notify, [{ kind: 'model', model: 'Msg' }]);
    Model.destroy('ghost');

    expect(notify).not.toHaveBeenCalled();
    Model.__applyRows?.([{ id: 'ghost', chatId: 'c1' }]);
    expect(Model.get('ghost')).toBeUndefined();
    subscription.unsubscribe();
  });

  it('same-tick membership survives the delta path', () => {
    const { Model } = setup();
    Model.insertStored({ id: 'tick', chatId: 'c9' });

    expect(Model.scopes.thread.read({ chatId: 'c9' }).map(row => (row as { id: string }).id)).toEqual(['tick']);
  });
});
