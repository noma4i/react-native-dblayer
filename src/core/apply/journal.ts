import { sortBy } from 'es-toolkit';
import type { StoragePlane, Journal, JournalOp, JournalRecord, PersistedJournalRecord } from '../../types';
import { noteCorruptionJournalDrop, noteCorruptionJournalLoss, noteDataLoss } from '../diagnostics';
import { getDbLogger } from '../logger';
import { decodePersistence, decodeSupportedPersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION, versionPersistenceValue } from '../persistenceCodec';

const COMMITTED_CAP = 50;
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_OP_SCHEMA_VERSION = 1;

const checkpointEpoch = (storage: StoragePlane, prefix: string): number => {
  const raw = storage.get(`${prefix}meta`);
  if (!raw) return 0;
  const parsed = decodeSupportedPersistence(
    raw,
    PERSISTENCE_SCHEMA_VERSION,
    (value): value is { lastCheckpointEpoch: number } =>
      typeof value === 'object' && value !== null && typeof (value as { lastCheckpointEpoch?: unknown }).lastCheckpointEpoch === 'number'
  );
  return parsed?.lastCheckpointEpoch ?? 0;
};

const epochFromKey = (prefix: string, journalKey: string): number => Number(journalKey.slice(`${prefix}journal:`.length));

const isValidJournalOp = (value: unknown): value is JournalOp => {
  if (typeof value !== 'object' || value === null) return false;
  const op = value as { kind?: unknown; model?: unknown; rows?: unknown; ids?: unknown; scopeKey?: unknown; next?: unknown; append?: unknown; detach?: unknown };
  if (typeof op.model !== 'string') return false;
  if (op.kind === 'upsert')
    return (
      Array.isArray(op.rows) &&
      op.rows.every(row => typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'string')
    );
  if (op.kind === 'destroy') return Array.isArray(op.ids) && op.ids.every(id => typeof id === 'string');
  if (op.kind === 'scope') return typeof op.scopeKey === 'string' && typeof op.next === 'object' && op.next !== null;
  if (op.kind === 'scope-delta')
    return (
      typeof op.scopeKey === 'string' &&
      Array.isArray(op.append) &&
      op.append.every(row => typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'string') &&
      Array.isArray(op.detach) &&
      op.detach.every(id => typeof id === 'string')
    );
  return false;
};

const isPersistedJournalRecord = (value: unknown): value is PersistedJournalRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { txId?: unknown; runtimeEpoch?: unknown; epoch?: unknown; status?: unknown; ops?: unknown };
  return (
    typeof record.txId === 'string' &&
    typeof record.runtimeEpoch === 'number' &&
    typeof record.epoch === 'number' &&
    (record.status === 'pending' || record.status === 'committed') &&
    Array.isArray(record.ops) &&
    record.ops.every(
      op =>
        typeof op === 'object' &&
        op !== null &&
        typeof (op as { schemaVersion?: unknown }).schemaVersion === 'number' &&
        'payload' in op
    )
  );
};

const encodeJournalRecord = (record: JournalRecord): string =>
  encodePersistence<PersistedJournalRecord>(
    {
      ...record,
      ops: record.ops.map(op => versionPersistenceValue(op, JOURNAL_OP_SCHEMA_VERSION))
    },
    JOURNAL_SCHEMA_VERSION
  );

/** Read one WAL record under the shared corruption policy: checkpointed corruption is dropped, while newer corruption is recorded as unavoidable loss. Covers both unparseable JSON and parseable JSON of the wrong record shape. */
export const readJournalRecord = (storage: StoragePlane, prefix: string, journalKey: string): JournalRecord | null => {
  const raw = storage.get(journalKey);
  if (!raw) return null;
  const dropAsCorrupt = (): null => {
    const epoch = epochFromKey(prefix, journalKey);
    const lastCheckpointEpoch = checkpointEpoch(storage, prefix);
    storage.set([{ key: journalKey, value: null }]);
    if (epoch <= lastCheckpointEpoch) {
      noteCorruptionJournalDrop();
      noteDataLoss('journal-corruption-checkpointed-drop', '__runtime__', 1);
      return null;
    }
    noteCorruptionJournalLoss();
    noteDataLoss('journal-corruption-loss', '__runtime__', 1);
    getDbLogger().error('unrecoverable WAL corruption', { key: journalKey, epoch, lastCheckpointEpoch });
    return null;
  };
  const decoded = decodePersistence(raw, JOURNAL_SCHEMA_VERSION, isPersistedJournalRecord);
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'corrupt') return dropAsCorrupt();
  const ops: JournalOp[] = [];
  for (const versioned of decoded.value.ops) {
    if (versioned.schemaVersion !== JOURNAL_OP_SCHEMA_VERSION) throw new Error(`Unsupported persistence schema version ${versioned.schemaVersion}`);
    if (!isValidJournalOp(versioned.payload)) return dropAsCorrupt();
    ops.push(versioned.payload);
  }
  return { ...decoded.value, ops };
};

export const createJournal = (storage: StoragePlane, prefix: () => string): Journal => {
  const key = (name: string) => `${prefix()}${name}`;
  const recordKey = (epoch: number) => key(`journal:${epoch}`);

  const allRecords = (): JournalRecord[] =>
    sortBy(
      storage
        .keys(key('journal:'))
        .map(journalKey => readJournalRecord(storage, prefix(), journalKey))
        .filter((record): record is JournalRecord => record !== null),
      [record => record.epoch]
    );

  /** In-memory committed-epoch index, loaded once - the hot path never re-reads the journal. */
  let committedEpochs: number[] | null = null;
  const committedIndex = (): number[] =>
    (committedEpochs ??= allRecords()
      .filter(record => record.status === 'committed')
      .map(record => record.epoch));
  const pruneCommitted = (pruneBeforeEpoch: number): Array<{ key: string; value: string | null }> => {
    const index = committedIndex();
    const prunable = index.filter(epoch => epoch <= pruneBeforeEpoch).sort((a, b) => a - b);
    const stale = prunable.slice(0, Math.max(0, index.length - COMMITTED_CAP));
    for (const epoch of stale) index.splice(index.indexOf(epoch), 1);
    return stale.map(epoch => ({ key: recordKey(epoch), value: null }));
  };

  return {
    /** Storage entry for one pending WAL record, composed with other durable state in one batch. */
    pendingEntry: (record: JournalRecord): Array<{ key: string; value: string | null }> => [{ key: recordKey(record.epoch), value: encodeJournalRecord(record) }],
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record: JournalRecord, pruneBeforeEpoch = Number.POSITIVE_INFINITY): Array<{ key: string; value: string | null }> => {
      const index = committedIndex();
      const entries: Array<{ key: string; value: string | null }> = [{ key: recordKey(record.epoch), value: encodeJournalRecord({ ...record, status: 'committed' }) }];
      if (!index.includes(record.epoch)) index.push(record.epoch);
      entries.push(...pruneCommitted(pruneBeforeEpoch));
      return entries;
    },
    /** Prune committed records after their checkpoint batch has completed successfully. */
    pruneCommitted,
    allRecords,
    pending: (): JournalRecord[] => allRecords().filter(record => record.status === 'pending'),
    lastEpoch: (): number => allRecords().reduce((max, record) => Math.max(max, record.epoch), 0)
  };
};
