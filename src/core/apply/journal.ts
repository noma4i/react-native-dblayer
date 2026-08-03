import { sortBy } from 'es-toolkit';
import type { Journal, JournalOp, JournalRecord, PersistedJournalRecord, StoragePlane } from '../../types';
import type { DecodedJournalRecord } from '../../types/core.persistenceInternals.types';
import { isOperationTransition } from '../planes/operationState';
import { noteCorruptionJournalDrop, noteCorruptionJournalLoss, noteDataLoss } from '../diagnostics';
import { decodePersistence, encodePersistence, PERSISTENCE_SCHEMA_VERSION, versionPersistenceValue } from '../persistenceCodec';
import { isNonArrayRecord, isNonEmptyString, isNonNegativeSafeInteger, isPositiveSafeInteger } from '../../utils/normalizeHelpers';
import { isScopeEntrySet, isScopeIndexValue } from '../planes/scopeIndex';

const JOURNAL_RECORD_VERSION = 2;
const JOURNAL_OP_SCHEMA_VERSION = 1;
const OPERATION_TRANSITION_SCHEMA_VERSION = 1;

export const readCheckpointEpoch = (storage: StoragePlane, prefix: string): number => {
  const metaKey = `${prefix}meta`;
  const raw = storage.get(metaKey);
  if (!raw) return 0;
  const decoded = decodePersistence(
    raw,
    PERSISTENCE_SCHEMA_VERSION,
    (value): value is { lastCheckpointEpoch: number } => isNonArrayRecord(value) && isNonNegativeSafeInteger(value.lastCheckpointEpoch)
  );
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'ok') return decoded.value.lastCheckpointEpoch;
  storage.set(metaKey, null);
  noteDataLoss('corrupt-checkpoint-meta', '__runtime__', 1);
  return 0;
};

const epochFromKey = (prefix: string, journalKey: string): number | undefined => {
  const rawEpoch = journalKey.slice(`${prefix}journal:`.length);
  if (!/^[1-9]\d*$/.test(rawEpoch)) return undefined;
  const epoch = Number(rawEpoch);
  return isPositiveSafeInteger(epoch) ? epoch : undefined;
};

const isValidJournalOp = (value: unknown): value is JournalOp => {
  if (!isNonArrayRecord(value) || !isNonEmptyString(value.model)) return false;
  const op = value;
  if (op.kind === 'upsert') {
    return Array.isArray(op.rows) && op.rows.every(row => isNonArrayRecord(row) && isNonEmptyString(row.id)) && (op.origin === undefined || op.origin === 'replace');
  }
  if (op.kind === 'destroy') {
    return (
      Array.isArray(op.ids) &&
      op.ids.every(isNonEmptyString) &&
      (op.tombstone === undefined || typeof op.tombstone === 'boolean') &&
      (op.origin === undefined || op.origin === 'replace')
    );
  }
  if (op.kind === 'scope') return isNonEmptyString(op.scopeKey) && isScopeIndexValue(op.next);
  if (op.kind === 'scope-delta') return isNonEmptyString(op.scopeKey) && isScopeEntrySet(op.append) && Array.isArray(op.detach) && op.detach.every(isNonEmptyString);
  return false;
};

const isPersistedJournalRecord = (value: unknown, expectedEpoch: number): value is DecodedJournalRecord => {
  if (!isNonArrayRecord(value) || !isNonEmptyString(value.txId) || !isPositiveSafeInteger(value.runtimeEpoch) || value.epoch !== expectedEpoch || !('ops' in value)) return false;
  return value.recordVersion === JOURNAL_RECORD_VERSION && 'operationTransitions' in value;
};

const decodeValues = <T>(values: unknown, version: number, accepts: (value: unknown) => value is T): T[] | null => {
  if (!Array.isArray(values)) return null;
  const decoded: T[] = [];
  for (const value of values) {
    if (!isNonArrayRecord(value) || !isPositiveSafeInteger(value.schemaVersion) || !('payload' in value)) return null;
    if (value.schemaVersion !== version) throw new Error(`Unsupported persistence schema version ${value.schemaVersion}`);
    if (!accepts(value.payload)) return null;
    decoded.push(value.payload);
  }
  return decoded;
};

const encodeJournalRecord = (record: JournalRecord): string =>
  encodePersistence<PersistedJournalRecord>({
    recordVersion: JOURNAL_RECORD_VERSION,
    txId: record.txId,
    runtimeEpoch: record.runtimeEpoch,
    epoch: record.epoch,
    ops: record.ops.map(op => versionPersistenceValue(op, JOURNAL_OP_SCHEMA_VERSION)),
    operationTransitions: record.operationTransitions.map(transition => versionPersistenceValue(transition, OPERATION_TRANSITION_SCHEMA_VERSION))
  });

/** Read one immutable WAL record and localize corruption after checkpoint coverage. */
export const readJournalRecord = (storage: StoragePlane, prefix: string, journalKey: string): JournalRecord | null => {
  const raw = storage.get(journalKey);
  if (!raw) return null;
  const journalEpoch = epochFromKey(prefix, journalKey);
  const dropAsLoss = (): null => {
    storage.set(journalKey, null);
    noteCorruptionJournalLoss();
    noteDataLoss('journal-corruption-loss', '__runtime__', 1);
    return null;
  };
  if (journalEpoch === undefined) return dropAsLoss();
  const dropAsCorrupt = (): null => {
    const lastCheckpointEpoch = readCheckpointEpoch(storage, prefix);
    if (journalEpoch <= lastCheckpointEpoch) {
      storage.set(journalKey, null);
      noteCorruptionJournalDrop();
      noteDataLoss('journal-corruption-checkpointed-drop', '__runtime__', 1);
      return null;
    }
    return dropAsLoss();
  };
  const decoded = decodePersistence(raw, PERSISTENCE_SCHEMA_VERSION, (value): value is DecodedJournalRecord => isPersistedJournalRecord(value, journalEpoch));
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'corrupt') return dropAsCorrupt();
  const ops = decodeValues(decoded.value.ops, JOURNAL_OP_SCHEMA_VERSION, isValidJournalOp);
  if (!ops) return dropAsCorrupt();
  const transitions = decodeValues(decoded.value.operationTransitions, OPERATION_TRANSITION_SCHEMA_VERSION, isOperationTransition);
  if (!transitions) return dropAsCorrupt();
  return {
    txId: decoded.value.txId,
    runtimeEpoch: decoded.value.runtimeEpoch,
    epoch: decoded.value.epoch,
    ops,
    operationTransitions: transitions
  };
};

export const createJournal = (storage: StoragePlane, prefix: () => string): Journal => {
  const recordKey = (epoch: number): string => `${prefix()}journal:${epoch}`;
  const allRecords = (): JournalRecord[] =>
    sortBy(
      storage
        .keys(`${prefix()}journal:`)
        .map(journalKey => readJournalRecord(storage, prefix(), journalKey))
        .filter((record): record is JournalRecord => record !== null),
      [record => record.epoch]
    );

  return {
    entry: record => ({ key: recordKey(record.epoch), value: encodeJournalRecord(record) }),
    coveredKeys: checkpoint =>
      allRecords()
        .filter(record => record.epoch <= checkpoint)
        .map(record => recordKey(record.epoch)),
    allRecords,
    lastEpoch: () => allRecords().reduce((max, record) => Math.max(max, record.epoch), 0)
  };
};
