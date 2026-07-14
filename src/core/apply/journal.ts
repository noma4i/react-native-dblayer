import type { StoragePlane } from '../planes/storagePlane';

export type JournalOp =
  | { kind: 'upsert'; model: string; rows: unknown[] }
  | { kind: 'destroy'; model: string; ids: string[] }
  | { kind: 'scope'; model: string; scopeHash: string; next: unknown }
  | { kind: 'freshness'; key: string; value: unknown }
  | { kind: 'counter'; model: string; id: string; field: string; delta: number };

export type JournalRecord = { epoch: number; planHash: string; status: 'pending' | 'committed'; ops: JournalOp[] };

export const createJournal = (storage: StoragePlane, prefix: string) => {
  const key = (name: string) => `${prefix}${name}`;
  return {
    writePending: (record: JournalRecord) => storage.set([{ key: key(`journal:${record.epoch}`), value: JSON.stringify(record) }]),
    markCommitted: (record: JournalRecord) => storage.set([{ key: key(`journal:${record.epoch}`), value: JSON.stringify({ ...record, status: 'committed' }) }]),
    pending: (): JournalRecord[] => storage.keys(key('journal:')).flatMap(journalKey => {
      const raw = storage.get(journalKey);
      if (!raw) return [];
      try {
        const record = JSON.parse(raw) as JournalRecord;
        return record.status === 'pending' ? [record] : [];
      } catch {
        storage.set([{ key: journalKey, value: null }]);
        return [];
      }
    })
  };
};
