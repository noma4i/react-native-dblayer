import type { ScopeIndexValue } from '../planes/scopeIndex';
import type { StoragePlane } from '../planes/storagePlane';

export type JournalOp =
  | { kind: 'upsert'; model: string; rows: unknown[]; origin?: 'event' | 'replace' }
  | { kind: 'patch'; model: string; id: string; patch: Record<string, unknown> }
  | { kind: 'destroy'; model: string; ids: string[]; tombstone?: boolean }
  | { kind: 'scope'; model: string; scopeKey: string; next: ScopeIndexValue }
  | { kind: 'scope-delta'; model: string; scopeKey: string; append: Array<{ id: string; edge?: Record<string, unknown>; order?: number }>; detach: string[] }
  | { kind: 'counter'; model: string; id: string; field: string; delta: number; next?: number };

export type JournalRecord = { epoch: number; status: 'pending' | 'committed'; ops: JournalOp[] };

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

  /** In-memory committed-epoch index, loaded once - the hot path never re-reads the journal. */
  let committedEpochs: number[] | null = null;
  const committedIndex = (): number[] => (committedEpochs ??= allRecords().filter(record => record.status === 'committed').map(record => record.epoch));
  const pruneCommitted = (pruneBeforeEpoch: number): Array<{ key: string; value: string | null }> => {
    const index = committedIndex();
    const prunable = index.filter(epoch => epoch <= pruneBeforeEpoch).sort((a, b) => a - b);
    const stale = prunable.slice(0, Math.max(0, index.length - COMMITTED_CAP));
    for (const epoch of stale) index.splice(index.indexOf(epoch), 1);
    return stale.map(epoch => ({ key: recordKey(epoch), value: null }));
  };

  return {
    writePending: (record: JournalRecord) => storage.set([{ key: recordKey(record.epoch), value: JSON.stringify(record) }]),
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record: JournalRecord, pruneBeforeEpoch = Number.POSITIVE_INFINITY): Array<{ key: string; value: string | null }> => {
      const index = committedIndex();
      const entries: Array<{ key: string; value: string | null }> = [
        { key: recordKey(record.epoch), value: JSON.stringify({ ...record, status: 'committed' }) }
      ];
      if (!index.includes(record.epoch)) index.push(record.epoch);
      entries.push(...pruneCommitted(pruneBeforeEpoch));
      return entries;
    },
    /** Prune committed records after their checkpoint batch has completed successfully. */
    pruneCommitted,
    allRecords,
    pending: (): JournalRecord[] => allRecords().filter(record => record.status === 'pending'),
    lastEpoch: (): number => allRecords().reduce((max, record) => Math.max(max, record.epoch), 0)
  };
};
