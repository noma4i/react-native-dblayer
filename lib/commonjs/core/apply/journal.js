"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.readJournalRecord = exports.createJournal = void 0;
var _esToolkit = require("es-toolkit");
var _diagnostics = require("../diagnostics.js");
var _logger = require("../logger.js");
const COMMITTED_CAP = 50;
const checkpointEpoch = (storage, prefix) => {
  const raw = storage.get(`${prefix}meta`);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && typeof parsed.lastCheckpointEpoch === 'number' ? parsed.lastCheckpointEpoch : 0;
  } catch {
    return 0;
  }
};
const epochFromKey = (prefix, journalKey) => Number(journalKey.slice(`${prefix}journal:`.length));
const VALID_JOURNAL_OP_KINDS = new Set(['upsert', 'patch', 'destroy', 'scope', 'scope-delta', 'counter']);
const isValidJournalOp = value => {
  if (typeof value !== 'object' || value === null) return false;
  const op = value;
  return typeof op.kind === 'string' && VALID_JOURNAL_OP_KINDS.has(op.kind) && typeof op.model === 'string';
};

/** Shape guard for a parsed-but-possibly-malformed record: valid JSON of the wrong shape (`ops` not an array, a stray op without `kind`/`model`, a non-numeric `epoch`) must route through the same corruption policy as a parse failure, not throw past it during replay. */
const isValidJournalRecord = value => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value;
  return typeof record.epoch === 'number' && (record.status === 'pending' || record.status === 'committed') && Array.isArray(record.ops) && record.ops.every(isValidJournalOp);
};

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
    if (epoch <= lastCheckpointEpoch) {
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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return dropAsCorrupt();
  }
  return isValidJournalRecord(parsed) ? parsed : dropAsCorrupt();
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
      value: JSON.stringify(record)
    }],
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record, pruneBeforeEpoch = Number.POSITIVE_INFINITY) => {
      const index = committedIndex();
      const entries = [{
        key: recordKey(record.epoch),
        value: JSON.stringify({
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