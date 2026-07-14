import type { ScopeIndexValue } from '../planes/scopeIndex';
import type { StoragePlane } from '../planes/storagePlane';

export type JournalOp =
  | { kind: 'upsert'; model: string; rows: unknown[]; origin?: 'event' | 'snapshot' }
  | { kind: 'patch'; model: string; id: string; patch: Record<string, unknown> }
  | { kind: 'destroy'; model: string; ids: string[] }
  | { kind: 'scope'; model: string; scopeKey: string; next: ScopeIndexValue }
  | { kind: 'freshness'; key: string; value: unknown }
  | { kind: 'counter'; model: string; id: string; field: string; delta: number };

export type JournalRecord = { epoch: number; planHash: string; status: 'pending' | 'committed'; ops: JournalOp[] };

const COMMITTED_CAP = 50;

export const createJournal = (storage: StoragePlane, prefix: () => string) => {
  const key = (name: string) => `${prefix()}${name}`;
  const recordKey = (epoch: number) => key(`journal:${epoch}`);

  const readRecord = (journalKey: string): JournalRecord | null => {
    const raw = storage.get(journalKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as JournalRecord;
    } catch {
      storage.set([{ key: journalKey, value: null }]);
      return null;
    }
  };

  const allRecords = (): JournalRecord[] =>
    storage
      .keys(key('journal:'))
      .map(readRecord)
      .filter((record): record is JournalRecord => record !== null)
      .sort((a, b) => a.epoch - b.epoch);

  return {
    writePending: (record: JournalRecord) => storage.set([{ key: recordKey(record.epoch), value: JSON.stringify(record) }]),
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record: JournalRecord, pruneBeforeEpoch = Number.POSITIVE_INFINITY): Array<{ key: string; value: string | null }> => {
      const entries: Array<{ key: string; value: string | null }> = [
        { key: recordKey(record.epoch), value: JSON.stringify({ ...record, status: 'committed' }) }
      ];
      const committed = allRecords().filter(other => other.status === 'committed' && other.epoch !== record.epoch && other.epoch <= pruneBeforeEpoch);
      for (const stale of committed.slice(0, Math.max(0, committed.length + 1 - COMMITTED_CAP))) {
        entries.push({ key: recordKey(stale.epoch), value: null });
      }
      return entries;
    },
    allRecords,
    pending: (): JournalRecord[] => allRecords().filter(record => record.status === 'pending'),
    lastEpoch: (): number => allRecords().reduce((max, record) => Math.max(max, record.epoch), 0)
  };
};
