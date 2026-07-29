"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readJournalRecord = exports.createJournal = void 0;
var _esToolkit = require("es-toolkit");
var _diagnostics = require("../diagnostics.js");
var _logger = require("../logger.js");
var _persistenceCodec = require("../persistenceCodec.js");
var _normalizeHelpers = require("../../utils/normalizeHelpers.js");
var _scopeIndex = require("../planes/scopeIndex.js");
const COMMITTED_CAP = 50;
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_OP_SCHEMA_VERSION = 1;
const checkpointEpoch = (storage, prefix) => {
  const metaKey = `${prefix}meta`;
  const raw = storage.get(metaKey);
  if (!raw) return 0;
  const decoded = (0, _persistenceCodec.decodePersistence)(raw, _persistenceCodec.PERSISTENCE_SCHEMA_VERSION, value => (0, _normalizeHelpers.isNonArrayRecord)(value) && (0, _normalizeHelpers.isNonNegativeSafeInteger)(value.lastCheckpointEpoch));
  if (decoded.kind === 'unsupported') throw new Error(`Unsupported persistence schema version ${decoded.schemaVersion}`);
  if (decoded.kind === 'ok') return decoded.value.lastCheckpointEpoch;
  storage.set([{
    key: metaKey,
    value: null
  }]);
  (0, _diagnostics.noteDataLoss)('corrupt-checkpoint-meta', '__runtime__', 1);
  return 0;
};
const epochFromKey = (prefix, journalKey) => {
  const rawEpoch = journalKey.slice(`${prefix}journal:`.length);
  if (!/^[1-9]\d*$/.test(rawEpoch)) return undefined;
  const epoch = Number(rawEpoch);
  return (0, _normalizeHelpers.isPositiveSafeInteger)(epoch) ? epoch : undefined;
};
const isValidJournalOp = value => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(value) || !(0, _normalizeHelpers.isNonEmptyString)(value.model)) return false;
  const op = value;
  if (op.kind === 'upsert') return Array.isArray(op.rows) && op.rows.every(row => (0, _normalizeHelpers.isNonArrayRecord)(row) && (0, _normalizeHelpers.isNonEmptyString)(row.id)) && (op.origin === undefined || op.origin === 'replace');
  if (op.kind === 'destroy') return Array.isArray(op.ids) && op.ids.every(_normalizeHelpers.isNonEmptyString) && (op.tombstone === undefined || typeof op.tombstone === 'boolean') && (op.origin === undefined || op.origin === 'replace');
  if (op.kind === 'scope') return (0, _normalizeHelpers.isNonEmptyString)(op.scopeKey) && (0, _scopeIndex.isScopeIndexValue)(op.next);
  if (op.kind === 'scope-delta') return (0, _normalizeHelpers.isNonEmptyString)(op.scopeKey) && (0, _scopeIndex.isScopeEntrySet)(op.append) && Array.isArray(op.detach) && op.detach.every(_normalizeHelpers.isNonEmptyString);
  return false;
};
const isPersistedJournalRecord = value => {
  if (!(0, _normalizeHelpers.isNonArrayRecord)(value)) return false;
  const record = value;
  return (0, _normalizeHelpers.isNonEmptyString)(record.txId) && (0, _normalizeHelpers.isPositiveSafeInteger)(record.runtimeEpoch) && (0, _normalizeHelpers.isPositiveSafeInteger)(record.epoch) && (record.status === 'pending' || record.status === 'committed') && Array.isArray(record.ops) && record.ops.every(op => (0, _normalizeHelpers.isNonArrayRecord)(op) && (0, _normalizeHelpers.isPositiveSafeInteger)(op.schemaVersion) && 'payload' in op);
};
const encodeJournalRecord = record => (0, _persistenceCodec.encodePersistence)({
  ...record,
  ops: record.ops.map(op => (0, _persistenceCodec.versionPersistenceValue)(op, JOURNAL_OP_SCHEMA_VERSION))
}, JOURNAL_SCHEMA_VERSION);

/** Read one WAL record under the shared corruption policy: checkpointed corruption is dropped, while newer corruption is recorded as unavoidable loss. Covers both unparseable JSON and parseable JSON of the wrong record shape. */
const readJournalRecord = (storage, prefix, journalKey) => {
  const raw = storage.get(journalKey);
  if (!raw) return null;
  const dropAsCorrupt = () => {
    const epoch = epochFromKey(prefix, journalKey);
    const lastCheckpointEpoch = checkpointEpoch(storage, prefix);
    storage.set([{
      key: journalKey,
      value: null
    }]);
    if (epoch !== undefined && epoch <= lastCheckpointEpoch) {
      (0, _diagnostics.noteCorruptionJournalDrop)();
      (0, _diagnostics.noteDataLoss)('journal-corruption-checkpointed-drop', '__runtime__', 1);
      return null;
    }
    (0, _diagnostics.noteCorruptionJournalLoss)();
    (0, _diagnostics.noteDataLoss)('journal-corruption-loss', '__runtime__', 1);
    (0, _logger.getDbLogger)().error('unrecoverable WAL corruption', {
      key: journalKey,
      epoch,
      lastCheckpointEpoch
    });
    return null;
  };
  const decoded = (0, _persistenceCodec.decodePersistence)(raw, JOURNAL_SCHEMA_VERSION, isPersistedJournalRecord);
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
exports.readJournalRecord = readJournalRecord;
const createJournal = (storage, prefix) => {
  const key = name => `${prefix()}${name}`;
  const recordKey = epoch => key(`journal:${epoch}`);
  const allRecords = () => (0, _esToolkit.sortBy)(storage.keys(key('journal:')).map(journalKey => readJournalRecord(storage, prefix(), journalKey)).filter(record => record !== null), [record => record.epoch]);

  /** In-memory committed-epoch index, loaded once - the hot path never re-reads the journal. */
  let committedEpochs = null;
  const committedIndex = () => committedEpochs ??= allRecords().filter(record => record.status === 'committed').map(record => record.epoch);
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
    pendingEntry: record => [{
      key: recordKey(record.epoch),
      value: encodeJournalRecord(record)
    }],
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record, pruneBeforeEpoch = Number.POSITIVE_INFINITY) => {
      const index = committedIndex();
      const entries = [{
        key: recordKey(record.epoch),
        value: encodeJournalRecord({
          ...record,
          status: 'committed'
        })
      }];
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
exports.createJournal = createJournal;
//# sourceMappingURL=journal.js.map