import { configureDb, createJournal, encodePersistence, readJournalRecord, versionPersistenceValue } from '../../testApi';
import type { JournalRecord } from '../../testApi';
import { createMemoryPlane, createMockTransport, diagnostics } from '../helpers/harness';

const PREFIX = 'dbl:';

const setup = () => {
  const storage = createMemoryPlane();
  configureDb({ storage, transport: createMockTransport() });
  diagnostics().reset();
  return { storage, journal: createJournal(storage, () => PREFIX) };
};

const record = (epoch: number, model = 'SpecJournalModel'): JournalRecord => ({
  txId: `test:${epoch}`,
  runtimeEpoch: 1,
  epoch,
  ops: [{ kind: 'upsert', model, rows: [{ id: `row-${epoch}` }] }],
  operationTransitions: []
});

const encodeRecord = (value: JournalRecord, overrides: Record<string, unknown> = {}): string =>
  encodePersistence({
    recordVersion: 2,
    txId: value.txId,
    runtimeEpoch: value.runtimeEpoch,
    epoch: value.epoch,
    ops: value.ops.map(op => versionPersistenceValue(op)),
    operationTransitions: value.operationTransitions.map(transition => versionPersistenceValue(transition)),
    ...overrides
  });

describe('immutable WAL corruption policy', () => {
  it('drops a stale-version record as routine evolution, not corruption', () => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set(key, encodeRecord(record(1), { recordVersion: 1 }));

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(storage.get(key)).toBeUndefined();
    expect(diagnostics().snapshot().corruptionJournalLosses).toBe(0);
    expect(diagnostics().snapshot().corruptionJournalDrops).toBe(0);
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({ mechanism: 'journal-stale-version-drop', model: '__runtime__', count: 1 });
  });

  it('writes one versioned checksummed record containing row work and transitions', () => {
    const { journal } = setup();
    const value: JournalRecord = {
      ...record(1),
      operationTransitions: [
        {
          kind: 'begin',
          operation: {
            operationId: 'operation-1',
            actionKey: 'send',
            actionMode: 'durable',
            model: 'SpecJournalModel',
            tempIds: ['row-1'],
            rowIds: ['row-1'],
            intent: 'insert',
            createdAt: 1
          }
        }
      ]
    };

    const entry = journal.entry(value);
    const persisted = JSON.parse(entry.value!) as { schemaVersion: unknown; checksum: unknown; payload: Record<string, unknown> };

    expect(entry.key).toBe(`${PREFIX}journal:1`);
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.checksum).toEqual(expect.stringMatching(/^[0-9a-f]{8}$/));
    expect(persisted.payload).toMatchObject({
      recordVersion: 2,
      epoch: 1,
      ops: [{ schemaVersion: 1, payload: { kind: 'upsert' } }],
      operationTransitions: [{ schemaVersion: 1, payload: { kind: 'begin' } }]
    });
  });

  it('refuses an unsupported outer schema without deleting the record', () => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set(key, JSON.stringify({ schemaVersion: 999, checksum: '00000000', payload: record(1) }));

    expect(() => readJournalRecord(storage, PREFIX, key)).toThrow('Unsupported persistence schema version 999');
    expect(storage.get(key)).toBeDefined();
  });

  it.each([
    ['an empty transaction id', { recordVersion: 2, txId: '', runtimeEpoch: 1, epoch: 1, ops: [], operationTransitions: [] }],
    ['a zero runtime epoch', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 0, epoch: 1, ops: [], operationTransitions: [] }],
    ['missing operations', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, operationTransitions: [] }],
    ['missing transitions', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [] }],
    ['non-array operations', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: {}, operationTransitions: [] }],
    ['a non-record operation wrapper', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [null], operationTransitions: [] }],
    ['a zero operation schema', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [{ schemaVersion: 0, payload: {} }], operationTransitions: [] }],
    ['an operation wrapper without payload', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [{ schemaVersion: 1 }], operationTransitions: [] }],
    ['an invalid operation payload', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [{ schemaVersion: 1, payload: { kind: 'upsert' } }], operationTransitions: [] }],
    ['non-array transitions', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [], operationTransitions: {} }],
    ['a non-record transition wrapper', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [], operationTransitions: [null] }],
    ['a zero transition schema', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [], operationTransitions: [{ schemaVersion: 0, payload: {} }] }],
    ['a transition wrapper without payload', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [], operationTransitions: [{ schemaVersion: 1 }] }],
    ['an invalid transition payload', { recordVersion: 2, txId: 'test:1', runtimeEpoch: 1, epoch: 1, ops: [], operationTransitions: [{ schemaVersion: 1, payload: { kind: 'other' } }] }]
  ])('drops a valid-checksum record with %s', (_label, payload) => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set(key, encodePersistence(payload));

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(storage.get(key)).toBeUndefined();
    expect(diagnostics().snapshot().corruptionJournalLosses).toBe(1);
  });

  it('returns a missing record without reporting corruption', () => {
    const { storage } = setup();

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:1`)).toBeNull();
    expect(diagnostics().snapshot().corruptionJournalLosses).toBe(0);
    expect(diagnostics().snapshot().corruptionJournalDrops).toBe(0);
    expect(diagnostics().snapshot().dataLossEvents).toEqual([]);
  });

  it('routes a malformed journal key through uncheckpointed loss', () => {
    const { storage } = setup();
    const key = `${PREFIX}journal:not-an-epoch`;
    storage.set(key, encodeRecord(record(1)));
    const get = jest.spyOn(storage, 'get');

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(storage.get(key)).toBeUndefined();
    expect(diagnostics().snapshot().corruptionJournalLosses).toBe(1);
    expect(diagnostics().snapshot().corruptionJournalDrops).toBe(0);
  });

  it('refuses an unsupported nested schema without deleting the record', () => {
    const { storage } = setup();
    const key = `${PREFIX}journal:1`;
    storage.set(
      key,
      encodeRecord(record(1), {
        ops: [versionPersistenceValue({ kind: 'upsert', model: 'SpecJournalModel', rows: [{ id: 'row-1' }] }, 2)]
      })
    );

    expect(() => readJournalRecord(storage, PREFIX, key)).toThrow('Unsupported persistence schema version 2');
    expect(storage.get(key)).toBeDefined();
  });

  it('routes checksum mismatch through uncheckpointed loss', () => {
    const { storage, journal } = setup();
    const key = `${PREFIX}journal:1`;
    const persisted = JSON.parse(journal.entry(record(1)).value!) as { checksum: string };
    persisted.checksum = persisted.checksum === '00000000' ? 'ffffffff' : '00000000';
    storage.set(key, JSON.stringify(persisted));

    expect(readJournalRecord(storage, PREFIX, key)).toBeNull();
    expect(storage.get(key)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({
      mechanism: 'journal-corruption-loss',
      model: '__runtime__',
      count: 1
    });
  });

  it('drops corrupt records covered by the durable checkpoint', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}meta`, encodePersistence({ lastCheckpointEpoch: 9 }));
    storage.set(`${PREFIX}journal:7`, '{corrupt');

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:7`)).toBeNull();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({
      mechanism: 'journal-corruption-checkpointed-drop',
      model: '__runtime__',
      count: 1
    });
  });

  it('treats corrupt checkpoint metadata as epoch zero', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}meta`, '{corrupt');
    storage.set(`${PREFIX}journal:1`, '{corrupt');

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:1`)).toBeNull();
    expect(storage.get(`${PREFIX}meta`)).toBeUndefined();
    expect(diagnostics().snapshot().dataLossEvents).toContainEqual({
      mechanism: 'journal-corruption-loss',
      model: '__runtime__',
      count: 1
    });
  });

  it('drops records whose key epoch disagrees with the payload', () => {
    const { storage } = setup();
    storage.set(`${PREFIX}journal:2`, encodeRecord(record(1)));

    expect(readJournalRecord(storage, PREFIX, `${PREFIX}journal:2`)).toBeNull();
    expect(diagnostics().snapshot().corruptionJournalLosses).toBe(1);
  });

  it('reads immutable records in epoch order and reports coverage', () => {
    const { storage, journal } = setup();
    for (const epoch of [5, 2, 9]) {
      const entry = journal.entry(record(epoch));
      storage.set(entry.key, entry.value);
    }

    expect(journal.allRecords().map(value => value.epoch)).toEqual([2, 5, 9]);
    expect(journal.coveredKeys(5)).toEqual([`${PREFIX}journal:2`, `${PREFIX}journal:5`]);
    expect(journal.lastEpoch()).toBe(9);
  });

  it('returns epoch zero and no covered keys for an empty journal', () => {
    const { journal } = setup();

    expect(journal.lastEpoch()).toBe(0);
    expect(journal.allRecords()).toEqual([]);
    expect(journal.coveredKeys(10)).toEqual([]);
  });
});
