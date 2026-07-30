import { configureDb } from '../../legacyTestApi';
import { createJournal, readJournalRecord } from '../../../core/apply/journal';
import { encodePersistence, versionPersistenceValue } from '../../../core/persistenceCodec';
import type { JournalRecord } from '../../../types';
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
  txId: `test:${epoch}`,
  runtimeEpoch: 1,
  epoch,
  status: 'pending' as const,
  ops: [{ kind: 'upsert' as const, model, rows: [{ id: `row-${epoch}` }] }]
});

const encodeRecord = (record: JournalRecord): string =>
  encodePersistence({
    ...record,
    ops: record.ops.map(op => versionPersistenceValue(op))
  });

const encodePersistedRecord = (overrides: Record<string, unknown> = {}): string => {
  const record = pendingRecord(1);
  return encodePersistence({
    ...record,
    ops: record.ops.map(op => versionPersistenceValue(op)),
    ...overrides
  });
};

const encodePersistedOp = (payload: unknown): string => encodePersistedRecord({ ops: [versionPersistenceValue(payload)] });

describe('journal corruption policy', () => {
  it('writes a versioned checksummed envelope around every journal record', () => {
    const { journal } = setup();
    const record = pendingRecord(1);

    const encoded = journal.pendingEntry(record)[0]!.value;
    const persisted = JSON.parse(encoded!) as { schemaVersion?: unknown; checksum?: unknown; payload?: unknown };

    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.checksum).toEqual(expect.stringMatching(/^[0-9a-f]{8}$/));
    expect(persisted.payload).toEqual({
      ...record,
      ops: record.ops.map(op => ({ schemaVersion: 1, payload: op }))
    });
  });

  it('refuses an unsupported journal schema version instead of deleting it as corruption', () => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set([{ key, value: JSON.stringify({ schemaVersion: 999, checksum: '00000000', payload: pendingRecord(1) }) }]);

    expect(() => readJournalRecord(storage, PREFIX, key)).toThrow('Unsupported persistence schema version 999');
    expect(storage.get(key)).toBeDefined();
  });

  it('routes a checksum mismatch through the corruption policy', () => {
    const { storage, journal } = setup();
    const key = `${PREFIX}journal:1`;
    const persisted = JSON.parse(journal.pendingEntry(pendingRecord(1))[0]!.value!) as { checksum: string };
    persisted.checksum = persisted.checksum === '00000000' ? 'ffffffff' : '00000000';
    storage.set([{ key, value: JSON.stringify(persisted) }]);

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(storage.get(key)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'journal-corruption-loss', model: '__runtime__', count: 1 });
  });

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
      { key: `${PREFIX}meta`, value: encodePersistence({ lastCheckpointEpoch: 9 }) },
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

    const losses = diagnostics()
      .snapshot()
      .dataLossEvents.filter(event => event.mechanism === 'journal-corruption-loss');
    expect(losses).toHaveLength(2);
    expect(
      diagnostics()
        .snapshot()
        .dataLossEvents.filter(event => event.mechanism === 'corrupt-checkpoint-meta')
    ).toHaveLength(2);
    expect(storage.get(`${PREFIX}meta`)).toBeUndefined();
  });

  it.each([-1, 1.5])('rejects an invalid checkpoint epoch and classifies newer WAL corruption as loss: %s', invalidEpoch => {
    const { storage } = setup();
    storage.set([
      { key: `${PREFIX}meta`, value: encodePersistence({ lastCheckpointEpoch: invalidEpoch }) },
      { key: `${PREFIX}journal:1`, value: '{corrupt' }
    ]);

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:1`)).toBeNull();
    expect(storage.get(`${PREFIX}meta`)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'corrupt-checkpoint-meta', model: '__runtime__', count: 1 });
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'journal-corruption-loss', model: '__runtime__', count: 1 });
  });

  it('preserves an unsupported checkpoint metadata version and the WAL record it prevents classifying', () => {
    const { storage } = setup();
    const metaKey = `${PREFIX}meta`;
    const journalKey = `${PREFIX}journal:1`;
    storage.set([
      { key: metaKey, value: encodePersistence({ lastCheckpointEpoch: 1 }, 2) },
      { key: journalKey, value: '{corrupt' }
    ]);

    expect(() => readJournalRecord(storage, PREFIX, journalKey)).toThrow('Unsupported persistence schema version 2');
    expect(storage.get(metaKey)).toBeDefined();
    expect(storage.get(journalKey)).toBeDefined();
  });

  it('routes parseable JSON of the wrong record shape through the same corruption policy', () => {
    const { storage } = setup();
    const base = { txId: 'malformed', runtimeEpoch: 1, epoch: 7, status: 'pending' };
    const malformed = [
      encodePersistence({ ...base, epoch: '7', ops: [] }),
      encodePersistence({ ...base, status: 'weird', ops: [] }),
      encodePersistence({ ...base, ops: {} }),
      encodePersistence({ ...base, ops: [versionPersistenceValue({ model: 'M' })] }),
      encodePersistence({ ...base, ops: [versionPersistenceValue({ kind: 'sideways', model: 'M' })] }),
      encodePersistence({ ...base, ops: [versionPersistenceValue({ kind: 'upsert' })] }),
      encodePersistence(42)
    ];
    for (const [index, value] of malformed.entries()) {
      const journalKey = `${PREFIX}journal:${index + 1}`;
      storage.set([{ key: journalKey, value }]);
      expect(readJournalRecord(storage, PREFIX, journalKey)).toBeNull();
      expect(storage.get(journalKey)).toBeUndefined();
    }
    const losses = diagnostics()
      .snapshot()
      .dataLossEvents.filter(event => event.mechanism === 'journal-corruption-loss');
    expect(losses).toHaveLength(malformed.length);
  });

  it.each([
    ['empty transaction id', { txId: '' }],
    ['zero runtime epoch', { runtimeEpoch: 0 }],
    ['fractional runtime epoch', { runtimeEpoch: 1.5 }],
    ['zero journal epoch', { epoch: 0 }],
    ['fractional journal epoch', { epoch: 1.5 }]
  ])('rejects a semantically invalid record envelope: %s', (_label, override) => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set([{ key, value: encodePersistedRecord(override) }]);

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(storage.get(key)).toBeUndefined();
  });

  it.each([
    ['empty model', { kind: 'upsert', model: '', rows: [{ id: 'row-1' }] }],
    ['empty row id', { kind: 'upsert', model: 'M', rows: [{ id: '' }] }],
    ['invalid replace origin', { kind: 'upsert', model: 'M', rows: [{ id: 'row-1' }], origin: 'sideways' }],
    ['empty destroy id', { kind: 'destroy', model: 'M', ids: [''] }],
    ['invalid tombstone flag', { kind: 'destroy', model: 'M', ids: ['row-1'], tombstone: 'yes' }],
    ['invalid destroy origin', { kind: 'destroy', model: 'M', ids: ['row-1'], origin: 'sideways' }],
    ['empty scope key', { kind: 'scope', model: 'M', scopeKey: '', next: { generation: 1, coverage: 'complete', entries: [] } }],
    ['missing scope generation', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { coverage: 'complete', entries: [] } }],
    ['fractional scope generation', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { generation: 1.5, coverage: 'complete', entries: [] } }],
    ['invalid scope coverage', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { generation: 1, coverage: 'all', entries: [] } }],
    ['missing scope order key', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { generation: 1, coverage: 'complete', entries: [{ id: 'row-1' }] } }],
    ['invalid scope order alphabet', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: 'V!' }] } }],
    ['non-fractional scope order tail', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { generation: 1, coverage: 'complete', entries: [{ id: 'row-1', orderKey: 'V0' }] } }],
    [
      'duplicate scope member id',
      {
        kind: 'scope',
        model: 'M',
        scopeKey: 'feed',
        next: {
          generation: 1,
          coverage: 'complete',
          entries: [
            { id: 'row-1', orderKey: 'V' },
            { id: 'row-1', orderKey: 'W' }
          ]
        }
      }
    ],
    [
      'duplicate scope order key',
      {
        kind: 'scope',
        model: 'M',
        scopeKey: 'feed',
        next: {
          generation: 1,
          coverage: 'complete',
          entries: [
            { id: 'row-1', orderKey: 'V' },
            { id: 'row-2', orderKey: 'V' }
          ]
        }
      }
    ],
    [
      'non-canonical scope entry order',
      {
        kind: 'scope',
        model: 'M',
        scopeKey: 'feed',
        next: {
          generation: 1,
          coverage: 'complete',
          entries: [
            { id: 'row-2', orderKey: 'W' },
            { id: 'row-1', orderKey: 'V' }
          ]
        }
      }
    ],
    ['unresolved scope with members', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { generation: 0, coverage: 'delta', entries: [{ id: 'row-1', orderKey: 'V' }] } }],
    ['unresolved complete scope', { kind: 'scope', model: 'M', scopeKey: 'feed', next: { generation: 0, coverage: 'complete', entries: [] } }],
    ['empty scope-delta key', { kind: 'scope-delta', model: 'M', scopeKey: '', append: [], detach: [] }],
    ['missing appended order key', { kind: 'scope-delta', model: 'M', scopeKey: 'feed', append: [{ id: 'row-1' }], detach: [] }],
    ['invalid appended order key', { kind: 'scope-delta', model: 'M', scopeKey: 'feed', append: [{ id: 'row-1', orderKey: '!' }], detach: [] }],
    [
      'duplicate appended id',
      {
        kind: 'scope-delta',
        model: 'M',
        scopeKey: 'feed',
        append: [
          { id: 'row-1', orderKey: 'V' },
          { id: 'row-1', orderKey: 'W' }
        ],
        detach: []
      }
    ],
    [
      'duplicate appended order key',
      {
        kind: 'scope-delta',
        model: 'M',
        scopeKey: 'feed',
        append: [
          { id: 'row-1', orderKey: 'V' },
          { id: 'row-2', orderKey: 'V' }
        ],
        detach: []
      }
    ],
    ['empty detached id', { kind: 'scope-delta', model: 'M', scopeKey: 'feed', append: [], detach: [''] }]
  ])('rejects a semantically invalid journal operation: %s', (_label, operation) => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set([{ key, value: encodePersistedOp(operation) }]);

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(storage.get(key)).toBeUndefined();
  });

  it.each(['not-an-epoch', '0', '1.5', '2', '9007199254740992'])('rejects a WAL storage key that does not identify the payload epoch: %s', keyEpoch => {
    const { storage } = setup();
    const key = `${PREFIX}journal:${keyEpoch}`;
    storage.set([{ key, value: encodePersistedRecord() }]);

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(storage.get(key)).toBeUndefined();
  });

  it('does not interpret an unsafe journal-key integer as an epoch', () => {
    const storage = createMemoryPlane();
    const logger = { debug: jest.fn(), error: jest.fn() };
    configureDb({ storage, transport: createMockTransport(), logger });
    diagnostics().reset();
    const key = `${PREFIX}journal:9007199254740992`;
    storage.set([{ key, value: encodePersistedRecord() }]);

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('unrecoverable WAL corruption', {
      key,
      epoch: undefined,
      lastCheckpointEpoch: 0
    });
  });

  it('refuses an unsupported nested operation schema version without deleting the record', () => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set([{ key, value: encodePersistedRecord({ ops: [versionPersistenceValue({ kind: 'upsert', model: 'M', rows: [{ id: 'row-1' }] }, 2)] }) }]);

    expect(() => readJournalRecord(storage, PREFIX, key)).toThrow('Unsupported persistence schema version 2');
    expect(storage.get(key)).toBeDefined();
  });

  it('reads valid pending and committed records untouched', () => {
    const { storage } = setup();
    const pending = pendingRecord(3);
    const committed = { ...pendingRecord(4), status: 'committed' as const };
    storage.set([
      { key: `${PREFIX}journal:3`, value: encodeRecord(pending) },
      { key: `${PREFIX}journal:4`, value: encodeRecord(committed) }
    ]);

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:3`)).toEqual(pending);
    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:4`)).toEqual(committed);
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });
});

describe('journal epoch scan and prune', () => {
  it('re-emits prune deletes after a failed commit batch - the epoch index only advances on durable success', () => {
    const { storage } = setup();
    for (let epoch = 1; epoch <= 52; epoch += 1) {
      const record = { ...pendingRecord(epoch), status: 'committed' as const };
      storage.set([{ key: `${PREFIX}journal:${epoch}`, value: encodeRecord(record) }]);
    }
    const fresh = createJournal(storage, () => PREFIX);
    const next = pendingRecord(53);
    storage.set(fresh.pendingEntry(next));

    const originalSet = storage.set.bind(storage);
    storage.set = () => {
      throw new Error('storage write failed');
    };
    expect(() => {
      const plan = fresh.committedEntry(next, Number.POSITIVE_INFINITY);
      storage.set(plan.entries);
      plan.commit();
    }).toThrow('storage write failed');
    storage.set = originalSet;

    const retry = fresh.committedEntry(next, Number.POSITIVE_INFINITY);
    storage.set(retry.entries);
    retry.commit();

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:1`)).toBeNull();
  });

  it('orders allRecords by epoch, filters pending, and reports the max epoch', () => {
    const { storage, journal } = setup();
    storage.set([
      { key: `${PREFIX}journal:5`, value: encodeRecord(pendingRecord(5)) },
      { key: `${PREFIX}journal:2`, value: encodeRecord({ ...pendingRecord(2), status: 'committed' }) },
      { key: `${PREFIX}journal:9`, value: encodeRecord(pendingRecord(9)) }
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
        value: encodeRecord({ ...pendingRecord(index + 1), status: 'committed' })
      }))
    );

    const entries = journal.pruneCommitted(Number.POSITIVE_INFINITY).entries;

    expect(entries.map(entry => entry.key)).toEqual(Array.from({ length: total - 50 }, (_, index) => `${PREFIX}journal:${index + 1}`));
    expect(entries.every(entry => entry.value === null)).toBe(true);
  });

  it('never prunes records newer than pruneBeforeEpoch even when the cap is exceeded', () => {
    const { storage, journal } = setup();
    storage.set(
      Array.from({ length: 55 }, (_, index) => ({
        key: `${PREFIX}journal:${index + 1}`,
        value: encodeRecord({ ...pendingRecord(index + 1), status: 'committed' })
      }))
    );

    expect(journal.pruneCommitted(3).entries.map(entry => entry.key)).toEqual([`${PREFIX}journal:1`, `${PREFIX}journal:2`, `${PREFIX}journal:3`]);
  });

  it('marks a record committed and prunes through committedEntry in one storage batch', () => {
    const { storage, journal } = setup();
    storage.set(
      Array.from({ length: 51 }, (_, index) => ({
        key: `${PREFIX}journal:${index + 1}`,
        value: encodeRecord({ ...pendingRecord(index + 1), status: 'committed' })
      }))
    );

    const entries = journal.committedEntry(pendingRecord(60)).entries;

    expect(entries[0]).toEqual({ key: `${PREFIX}journal:60`, value: encodeRecord({ ...pendingRecord(60), status: 'committed' }) });
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
    storage.set([{ key: `${PREFIX}journal:1`, value: encodeRecord({ ...pendingRecord(1), status: 'committed' }) }]);
    journal.committedEntry(pendingRecord(2));
    const scansAfterWarmup = scans;

    journal.committedEntry(pendingRecord(3));

    expect(scans).toBe(scansAfterWarmup);
  });
});
