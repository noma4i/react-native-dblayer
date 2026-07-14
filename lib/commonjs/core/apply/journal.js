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
  return {
    writePending: record => storage.set([{
      key: recordKey(record.epoch),
      value: JSON.stringify(record)
    }]),
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record, pruneBeforeEpoch = Number.POSITIVE_INFINITY) => {
      const entries = [{
        key: recordKey(record.epoch),
        value: JSON.stringify({
          ...record,
          status: 'committed'
        })
      }];
      const committed = allRecords().filter(other => other.status === 'committed' && other.epoch !== record.epoch && other.epoch <= pruneBeforeEpoch);
      for (const stale of committed.slice(0, Math.max(0, committed.length + 1 - COMMITTED_CAP))) {
        entries.push({
          key: recordKey(stale.epoch),
          value: null
        });
      }
      return entries;
    },
    allRecords,
    pending: () => allRecords().filter(record => record.status === 'pending'),
    lastEpoch: () => allRecords().reduce((max, record) => Math.max(max, record.epoch), 0)
  };
};
exports.createJournal = createJournal;
//# sourceMappingURL=journal.js.map