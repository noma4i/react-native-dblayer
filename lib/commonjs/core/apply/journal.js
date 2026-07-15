"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createJournal = void 0;
const COMMITTED_CAP = 50;
const createJournal = (storage, prefix) => {
  const key = name => `${prefix()}${name}`;
  const recordKey = epoch => key(`journal:${epoch}`);
  const readRecord = journalKey => {
    const raw = storage.get(journalKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      storage.set([{
        key: journalKey,
        value: null
      }]);
      return null;
    }
  };
  const allRecords = () => storage.keys(key('journal:')).map(readRecord).filter(record => record !== null).sort((a, b) => a.epoch - b.epoch);

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
    writePending: record => storage.set([{
      key: recordKey(record.epoch),
      value: JSON.stringify(record)
    }]),
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