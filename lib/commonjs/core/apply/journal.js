"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readJournalRecord = exports.readCheckpointEpoch = exports.createJournal = void 0;
var _esToolkit = require("es-toolkit");
var _operationState = require("../planes/operationState.js");
var _diagnostics = require("../diagnostics.js");
var _persistenceCodec = require("../persistenceCodec.js");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
var _scopeIndex = require("../planes/scopeIndex.js");
const JOURNAL_RECORD_VERSION = 2;
const JOURNAL_OP_SCHEMA_VERSION = 1;
const OPERATION_TRANSITION_SCHEMA_VERSION = 1;
const readCheckpointEpoch = (storage, prefix) => {
  const metaKey = `${prefix}meta`;
  const raw = storage.get(metaKey);
  if (!raw) return 0;
  const decoded = (0, _persistenceCodec.decodePersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, value => (0, _normalizeHelpers.isNonArrayRecord)(value) && (0, _normalizeHelpers.isNonNegativeSafeInteger)(value.lastCheckpointEpoch));
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'ok') return decoded.value.lastCheckpointEpoch;
  storage.set(metaKey, null);
  (0, _diagnostics.noteDataLoss)('corrupt-checkpoint-meta', '__runtime__', 1);
  return 0;
};
exports.readCheckpointEpoch = readCheckpointEpoch;
const epochFromKey = (prefix, journalKey) => {
  const rawEpoch = journalKey.slice(`${prefix}journal:`.length);
  if (!/^[1-9]\d*$/.test(rawEpoch)) return undefined;
  const epoch = Number(rawEpoch);
  return (0, _normalizeHelpers.isPositiveSafeInteger)(epoch) ? epoch : undefined;
};
const isValidJournalOp = value => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(value) || !(0, _normalizeHelpers.isNonEmptyString)(value.model)) return false;
  const op = value;
  if (op.kind === 'upsert') {
    return Array.isArray(op.rows) && op.rows.every(row => (0, _normalizeHelpers.isNonArrayRecord)(row) && (0, _normalizeHelpers.isNonEmptyString)(row.id)) && (op.origin === undefined || op.origin === 'replace');
  }
  if (op.kind === 'destroy') {
    return Array.isArray(op.ids) && op.ids.every(_normalizeHelpers.isNonEmptyString) && (op.tombstone === undefined || typeof op.tombstone === 'boolean') && (op.origin === undefined || op.origin === 'replace');
  }
  if (op.kind === 'scope') return (0, _normalizeHelpers.isNonEmptyString)(op.scopeKey) && (0, _scopeIndex.isScopeIndexValue)(op.next);
  if (op.kind === 'scope-delta') return (0, _normalizeHelpers.isNonEmptyString)(op.scopeKey) && (0, _scopeIndex.isScopeEntrySet)(op.append) && Array.isArray(op.detach) && op.detach.every(_normalizeHelpers.isNonEmptyString);
  return false;
};
const isPersistedJournalRecord = (value, expectedEpoch) => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(value) || !(0, _normalizeHelpers.isNonEmptyString)(value.txId) || !(0, _normalizeHelpers.isPositiveSafeInteger)(value.runtimeEpoch) || value.epoch !== expectedEpoch || !('ops' in value)) return false;
  return value.recordVersion === JOURNAL_RECORD_VERSION && 'operationTransitions' in value;
};
const decodeValues = (values, version, accepts) => {
  if (!Array.isArray(values)) return null;
  const decoded = [];
  for (const value of values) {
    if (!(0, _normalizeHelpers.isNonArrayRecord)(value) || !(0, _normalizeHelpers.isPositiveSafeInteger)(value.schemaVersion) || !('payload' in value)) return null;
    if (value.schemaVersion !== version) throw new Error(`Unsupported persistence schema version ${value.schemaVersion}`);
    if (!accepts(value.payload)) return null;
    decoded.push(value.payload);
  }
  return decoded;
};
const encodeJournalRecord = record => (0, _persistenceCodec.encodePersistence)({
  recordVersion: JOURNAL_RECORD_VERSION,
  txId: record.txId,
  runtimeEpoch: record.runtimeEpoch,
  epoch: record.epoch,
  ops: record.ops.map(op => (0, _persistenceCodec.versionPersistenceValue)(op, JOURNAL_OP_SCHEMA_VERSION)),
  operationTransitions: record.operationTransitions.map(transition => (0, _persistenceCodec.versionPersistenceValue)(transition, OPERATION_TRANSITION_SCHEMA_VERSION))
});

/** Read one immutable WAL record and localize corruption after checkpoint coverage. */
const readJournalRecord = (storage, prefix, journalKey) => {
  const raw = storage.get(journalKey);
  if (!raw) return null;
  const journalEpoch = epochFromKey(prefix, journalKey);
  const dropAsLoss = () => {
    storage.set(journalKey, null);
    (0, _diagnostics.noteCorruptionJournalLoss)();
    (0, _diagnostics.noteDataLoss)('journal-corruption-loss', '__runtime__', 1);
    return null;
  };
  if (journalEpoch === undefined) return dropAsLoss();
  const dropAsCorrupt = () => {
    const lastCheckpointEpoch = readCheckpointEpoch(storage, prefix);
    if (journalEpoch <= lastCheckpointEpoch) {
      storage.set(journalKey, null);
      (0, _diagnostics.noteCorruptionJournalDrop)();
      (0, _diagnostics.noteDataLoss)('journal-corruption-checkpointed-drop', '__runtime__', 1);
      return null;
    }
    return dropAsLoss();
  };
  const decoded = (0, _persistenceCodec.decodePersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, value => isPersistedJournalRecord(value, journalEpoch));
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'corrupt') return dropAsCorrupt();
  const ops = decodeValues(decoded.value.ops, JOURNAL_OP_SCHEMA_VERSION, isValidJournalOp);
  if (!ops) return dropAsCorrupt();
  const transitions = decodeValues(decoded.value.operationTransitions, OPERATION_TRANSITION_SCHEMA_VERSION, _operationState.isOperationTransition);
  if (!transitions) return dropAsCorrupt();
  return {
    txId: decoded.value.txId,
    runtimeEpoch: decoded.value.runtimeEpoch,
    epoch: decoded.value.epoch,
    ops,
    operationTransitions: transitions
  };
};
exports.readJournalRecord = readJournalRecord;
const createJournal = (storage, prefix) => {
  const recordKey = epoch => `${prefix()}journal:${epoch}`;
  const allRecords = () => (0, _esToolkit.sortBy)(storage.keys(`${prefix()}journal:`).map(journalKey => readJournalRecord(storage, prefix(), journalKey)).filter(record => record !== null), [record => record.epoch]);
  return {
    entry: record => ({
      key: recordKey(record.epoch),
      value: encodeJournalRecord(record)
    }),
    coveredKeys: checkpoint => allRecords().filter(record => record.epoch <= checkpoint).map(record => recordKey(record.epoch)),
    allRecords,
    lastEpoch: () => allRecords().reduce((max, record) => Math.max(max, record.epoch), 0)
  };
};
exports.createJournal = createJournal;
//# sourceMappingURL=journal.js.map