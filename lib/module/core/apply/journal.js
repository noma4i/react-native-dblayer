'use strict';

import { sortBy } from 'es-toolkit';
import { noteCorruptionJournalDrop, noteCorruptionJournalLoss, noteDataLoss } from '../diagnostics.js';
import { getDbLogger } from '../logger.js';
import { decodePersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION, versionPersistenceValue } from '../persistenceCodec.js';
import { isNonArrayRecord, isNonEmptyString, isNonNegativeSafeInteger, isPositiveSafeInteger } from '../../utils/normalizeHelpers.js';
import { isScopeEntrySet, isScopeIndexValue } from '../planes/scopeIndex.js';
const COMMITTED_CAP = 50;
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_OP_SCHEMA_VERSION = 1;
const checkpointEpoch = (storage, prefix) => {
  const metaKey = `${prefix}meta`;
  const raw = storage.get(metaKey);
  if (!raw) return 0;
  const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, value => isNonArrayRecord(value) && isNonNegativeSafeInteger(value.lastCheckpointEpoch));
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'ok') return decoded.value.lastCheckpointEpoch;
  storage.set([
    {
      key: metaKey,
      value: null
    }
  ]);
  noteDataLoss('corrupt-checkpoint-meta', '__runtime__', 1);
  return 0;
};
const epochFromKey = (prefix, journalKey) => {
  const rawEpoch = journalKey.slice(`${prefix}journal:`.length);
  if (!/^[1-9]\d*$/.test(rawEpoch)) return undefined;
  const epoch = Number(rawEpoch);
  return isPositiveSafeInteger(epoch) ? epoch : undefined;
};
const isValidJournalOp = value => {
  if (!isNonArrayRecord(value) || !isNonEmptyString(value.model)) return false;
  const op = value;
  if (op.kind === 'upsert')
    return Array.isArray(op.rows) && op.rows.every(row => isNonArrayRecord(row) && isNonEmptyString(row.id)) && (op.origin === undefined || op.origin === 'replace');
  if (op.kind === 'destroy')
    return (
      Array.isArray(op.ids) &&
      op.ids.every(isNonEmptyString) &&
      (op.tombstone === undefined || typeof op.tombstone === 'boolean') &&
      (op.origin === undefined || op.origin === 'replace')
    );
  if (op.kind === 'scope') return isNonEmptyString(op.scopeKey) && isScopeIndexValue(op.next);
  if (op.kind === 'scope-delta') return isNonEmptyString(op.scopeKey) && isScopeEntrySet(op.append) && Array.isArray(op.detach) && op.detach.every(isNonEmptyString);
  return false;
};
const isPersistedJournalRecord = value => {
  if (!isNonArrayRecord(value)) return false;
  const record = value;
  return (
    isNonEmptyString(record.txId) &&
    isPositiveSafeInteger(record.runtimeEpoch) &&
    isPositiveSafeInteger(record.epoch) &&
    (record.status === 'pending' || record.status === 'committed') &&
    Array.isArray(record.ops) &&
    record.ops.every(op => isNonArrayRecord(op) && isPositiveSafeInteger(op.schemaVersion) && 'payload' in op)
  );
};
const encodeJournalRecord = record =>
  encodePersistence(
    {
      ...record,
      ops: record.ops.map(op => versionPersistenceValue(op, JOURNAL_OP_SCHEMA_VERSION))
    },
    JOURNAL_SCHEMA_VERSION
  );

/** Read one WAL record under the shared corruption policy: checkpointed corruption is dropped, while newer corruption is recorded as unavoidable loss. Covers both unparseable JSON and parseable JSON of the wrong record shape. */
export const readJournalRecord = (storage, prefix, journalKey) => {
  const raw = storage.get(journalKey);
  if (!raw) return null;
  const dropAsCorrupt = () => {
    const epoch = epochFromKey(prefix, journalKey);
    const lastCheckpointEpoch = checkpointEpoch(storage, prefix);
    storage.set([
      {
        key: journalKey,
        value: null
      }
    ]);
    if (epoch !== undefined && epoch <= lastCheckpointEpoch) {
      noteCorruptionJournalDrop();
      noteDataLoss('journal-corruption-checkpointed-drop', '__runtime__', 1);
      return null;
    }
    noteCorruptionJournalLoss();
    noteDataLoss('journal-corruption-loss', '__runtime__', 1);
    getDbLogger().error('unrecoverable WAL corruption', {
      key: journalKey,
      epoch,
      lastCheckpointEpoch
    });
    return null;
  };
  const decoded = decodePersistence(raw, JOURNAL_SCHEMA_VERSION, isPersistedJournalRecord);
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'corrupt') return dropAsCorrupt();
  const ops = [];
  for (const versioned of decoded.value.ops) {
    if (versioned.schemaVersion !== JOURNAL_OP_SCHEMA_VERSION) throw new Error(`Unsupported persistence schema version ${versioned.schemaVersion}`);
    if (!isValidJournalOp(versioned.payload)) return dropAsCorrupt();
    ops.push(versioned.payload);
  }
  if (epochFromKey(prefix, journalKey) !== decoded.value.epoch) return dropAsCorrupt();
  return {
    ...decoded.value,
    ops
  };
};
export const createJournal = (storage, prefix) => {
  const key = name => `${prefix()}${name}`;
  const recordKey = epoch => key(`journal:${epoch}`);
  const allRecords = () =>
    sortBy(
      storage
        .keys(key('journal:'))
        .map(journalKey => readJournalRecord(storage, prefix(), journalKey))
        .filter(record => record !== null),
      [record => record.epoch]
    );

  /** In-memory committed-epoch index, loaded once - the hot path never re-reads the journal. */
  let committedEpochs = null;
  const committedIndex = () =>
    (committedEpochs ??= allRecords()
      .filter(record => record.status === 'committed')
      .map(record => record.epoch));
  const pruneCommitted = pruneBeforeEpoch => {
    const index = committedIndex();
    const prunable = index.filter(epoch => epoch <= pruneBeforeEpoch).sort((a, b) => a - b);
    const stale = prunable.slice(0, Math.max(0, index.length - COMMITTED_CAP));
    for (const epoch of stale) index.splice(index.indexOf(epoch), 1);
    return stale.map(epoch => ({
      key: recordKey(epoch),
      value: null
    }));
  };
  return {
    /** Storage entry for one pending WAL record, composed with other durable state in one batch. */
    pendingEntry: record => [
      {
        key: recordKey(record.epoch),
        value: encodeJournalRecord(record)
      }
    ],
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record, pruneBeforeEpoch = Number.POSITIVE_INFINITY) => {
      const index = committedIndex();
      const entries = [
        {
          key: recordKey(record.epoch),
          value: encodeJournalRecord({
            ...record,
            status: 'committed'
          })
        }
      ];
      if (!index.includes(record.epoch)) index.push(record.epoch);
      entries.push(...pruneCommitted(pruneBeforeEpoch));
      return entries;
    },
    /** Prune committed records after their checkpoint batch has completed successfully. */
    pruneCommitted,
    allRecords,
    pending: () => allRecords().filter(record => record.status === 'pending'),
    lastEpoch: () => allRecords().reduce((max, record) => Math.max(max, record.epoch), 0)
  };
};
//# sourceMappingURL=journal.js.map
