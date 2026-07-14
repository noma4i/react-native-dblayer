"use strict";

export const createJournal = (storage, prefix) => {
  const key = name => `${prefix}${name}`;
  return {
    writePending: record => storage.set([{
      key: key(`journal:${record.epoch}`),
      value: JSON.stringify(record)
    }]),
    markCommitted: record => storage.set([{
      key: key(`journal:${record.epoch}`),
      value: JSON.stringify({
        ...record,
        status: 'committed'
      })
    }]),
    pending: () => storage.keys(key('journal:')).flatMap(journalKey => {
      const raw = storage.get(journalKey);
      if (!raw) return [];
      try {
        const record = JSON.parse(raw);
        return record.status === 'pending' ? [record] : [];
      } catch {
        storage.set([{
          key: journalKey,
          value: null
        }]);
        return [];
      }
    })
  };
};
//# sourceMappingURL=journal.js.map