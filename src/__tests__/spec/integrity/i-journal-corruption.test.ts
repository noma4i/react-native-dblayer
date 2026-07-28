import { configureDb } from '../../../index';
import { createJournal, readJournalRecord } from '../../../core/apply/journal';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

/**
 * WAL journal corruption-policy and prune contracts. The mutation audit left the corrupt-guard,
 * checkpoint-routing, prune-cap, and epoch-scan branches unkilled (51% score) - each `it` pins one
 * of those durability guarantees: corruption is never thrown past, never silently ignored, and
 * always routed by "was it already checkpointed" into drop vs loss.
 */
const PREFIX = 'dbl:';

const setup = () => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() });
  diagnostics().reset();
  return { storage, journal: createJournal(storage, () => PREFIX) };
};

const pendingRecord = (epoch: number, model = 'SpecJournalModel') => ({
  epoch,
  status: 'pending' as const,
  ops: [{ kind: 'upsert' as const, model, rows: [{ id: `row-${epoch}` }] }]
});

describe('journal corruption policy', () => {
  it('counts un-checkpointed corruption as unrecoverable loss and deletes the record', () => {
    const { storage } = setup();
    storage.set([{ key: `${PREFIX}journal:7`, value: '{corrupt' }]);

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:7`)).toBeNull();

    expect(storage.get(`${PREFIX}journal:7`)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'journal-corruption-loss', model: '__runtime__', count: 1 });
  });

  it('drops checkpointed corruption quietly under the checkpointed-drop mechanism', () => {
    const { storage } = setup();
    storage.set([
      { key: `${PREFIX}meta`, value: JSON.stringify({ lastCheckpointEpoch: 9 }) },
      { key: `${PREFIX}journal:7`, value: '{corrupt' }
    ]);

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:7`)).toBeNull();

    const events = diagnostics().snapshot().dataLossEvents;
    expect(events).toContainEqual({ mechanism: 'journal-corruption-checkpointed-drop', model: '__runtime__', count: 1 });
    expect(events).not.toContainEqual(expect.objectContaining({ mechanism: 'journal-corruption-loss' }));
  });

  it('treats a corrupt or non-object checkpoint meta as epoch zero and routes to loss', () => {
    const { storage } = setup();
    storage.set([
      { key: `${PREFIX}meta`, value: '{not-json' },
      { key: `${PREFIX}journal:1`, value: '{corrupt' }
    ]);
    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:1`)).toBeNull();

    storage.set([
      { key: `${PREFIX}meta`, value: JSON.stringify({ lastCheckpointEpoch: 'nine' }) },
      { key: `${PREFIX}journal:2`, value: '{corrupt' }
    ]);
    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:2`)).toBeNull();

    const losses = diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'journal-corruption-loss');
    expect(losses).toHaveLength(2);
  });

  it('routes parseable JSON of the wrong record shape through the same corruption policy', () => {
    const { storage } = setup();
    const malformed = [
      JSON.stringify({ epoch: '7', status: 'pending', ops: [] }),
      JSON.stringify({ epoch: 7, status: 'weird', ops: [] }),
      JSON.stringify({ epoch: 7, status: 'pending', ops: {} }),
      JSON.stringify({ epoch: 7, status: 'pending', ops: [{ model: 'M' }] }),
      JSON.stringify({ epoch: 7, status: 'pending', ops: [{ kind: 'sideways', model: 'M' }] }),
      JSON.stringify({ epoch: 7, status: 'pending', ops: [{ kind: 'upsert' }] }),
      JSON.stringify(42)
    ];
    for (const [index, value] of malformed.entries()) {
      const journalKey = `${PREFIX}journal:${index + 1}`;
      storage.set([{ key: journalKey, value }]);
      expect(readJournalRecord(storage, PREFIX, journalKey)).toBeNull();
      expect(storage.get(journalKey)).toBeUndefined();
    }
    const losses = diagnostics().snapshot().dataLossEvents.filter(event => event.mechanism === 'journal-corruption-loss');
    expect(losses).toHaveLength(malformed.length);
  });

  it('reads valid pending and committed records untouched', () => {
    const { storage } = setup();
    const pending = pendingRecord(3);
    const committed = { ...pendingRecord(4), status: 'committed' as const };
    storage.set([
      { key: `${PREFIX}journal:3`, value: JSON.stringify(pending) },
      { key: `${PREFIX}journal:4`, value: JSON.stringify(committed) }
    ]);

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:3`)).toEqual(pending);
    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:4`)).toEqual(committed);
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });
});

describe('journal epoch scan and prune', () => {
  it('orders allRecords by epoch, filters pending, and reports the max epoch', () => {
    const { storage, journal } = setup();
    storage.set([
      { key: `${PREFIX}journal:5`, value: JSON.stringify(pendingRecord(5)) },
      { key: `${PREFIX}journal:2`, value: JSON.stringify({ ...pendingRecord(2), status: 'committed' }) },
      { key: `${PREFIX}journal:9`, value: JSON.stringify(pendingRecord(9)) }
    ]);

    expect(journal.allRecords().map(record => record.epoch)).toEqual([2, 5, 9]);
    expect(journal.pending().map(record => record.epoch)).toEqual([5, 9]);
    expect(journal.lastEpoch()).toBe(9);
  });

  it('reports epoch zero for an empty journal', () => {
    const { journal } = setup();
    expect(journal.lastEpoch()).toBe(0);
    expect(journal.pending()).toEqual([]);
  });

  it('prunes only checkpointed committed records beyond the retention cap, oldest first', () => {
    const { storage, journal } = setup();
    const total = 55;
    storage.set(
      Array.from({ length: total }, (_, index) => ({
        key: `${PREFIX}journal:${index + 1}`,
        value: JSON.stringify({ ...pendingRecord(index + 1), status: 'committed' })
      }))
    );

    const entries = journal.pruneCommitted(Number.POSITIVE_INFINITY);

    expect(entries.map(entry => entry.key)).toEqual(Array.from({ length: total - 50 }, (_, index) => `${PREFIX}journal:${index + 1}`));
    expect(entries.every(entry => entry.value === null)).toBe(true);
  });

  it('never prunes records newer than pruneBeforeEpoch even when the cap is exceeded', () => {
    const { storage, journal } = setup();
    storage.set(
      Array.from({ length: 55 }, (_, index) => ({
        key: `${PREFIX}journal:${index + 1}`,
        value: JSON.stringify({ ...pendingRecord(index + 1), status: 'committed' })
      }))
    );

    expect(journal.pruneCommitted(3).map(entry => entry.key)).toEqual([`${PREFIX}journal:1`, `${PREFIX}journal:2`, `${PREFIX}journal:3`]);
  });

  it('marks a record committed and prunes through committedEntry in one storage batch', () => {
    const { storage, journal } = setup();
    storage.set(
      Array.from({ length: 51 }, (_, index) => ({
        key: `${PREFIX}journal:${index + 1}`,
        value: JSON.stringify({ ...pendingRecord(index + 1), status: 'committed' })
      }))
    );

    const entries = journal.committedEntry(pendingRecord(60));

    expect(entries[0]).toEqual({ key: `${PREFIX}journal:60`, value: JSON.stringify({ ...pendingRecord(60), status: 'committed' }) });
    expect(entries.slice(1).map(entry => entry.key)).toEqual([`${PREFIX}journal:1`, `${PREFIX}journal:2`]);
  });

  it('serves the committed index from memory instead of re-reading the journal on the hot path', () => {
    const { storage } = setup();
    let scans = 0;
    const counting = {
      ...storage,
      keys: (prefix: string) => {
        scans += 1;
        return storage.keys(prefix);
      }
    };
    const journal = createJournal(counting, () => PREFIX);
    storage.set([{ key: `${PREFIX}journal:1`, value: JSON.stringify({ ...pendingRecord(1), status: 'committed' }) }]);
    journal.committedEntry(pendingRecord(2));
    const scansAfterWarmup = scans;

    journal.committedEntry(pendingRecord(3));

    expect(scans).toBe(scansAfterWarmup);
  });
});
