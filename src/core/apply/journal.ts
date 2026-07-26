import type { ScopeIndexValue } from '../planes/scopeIndex';
import type { StoragePlane } from '../planes/storagePlane';
import { noteCorruptionJournalDrop, noteCorruptionJournalLoss } from '../diagnostics';
import { getDbLogger } from '../logger';

export type JournalOp =
  | { kind: 'upsert'; model: string; rows: unknown[]; origin?: 'event'; mergeBase?: never }
  /** Replace carries the normalized prior row through WAL replay so mergePolicy observes the same commit semantics after restart. */
  | { kind: 'upsert'; model: string; rows: unknown[]; origin: 'replace'; mergeBase?: unknown }
  | { kind: 'patch'; model: string; id: string; patch: Record<string, unknown> }
  | { kind: 'destroy'; model: string; ids: string[]; tombstone?: boolean }
  | { kind: 'scope'; model: string; scopeKey: string; next: ScopeIndexValue }
  | { kind: 'scope-delta'; model: string; scopeKey: string; append: Array<{ id: string; edge?: Record<string, unknown>; order?: number }>; detach: string[] }
  | { kind: 'counter'; model: string; id: string; field: string; delta: number; next?: number };

export type JournalRecord = { epoch: number; status: 'pending' | 'committed'; ops: JournalOp[] };

const COMMITTED_CAP = 50;

const checkpointEpoch = (storage: StoragePlane, prefix: string): number => {
  const raw = storage.get(`${prefix}meta`);
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { lastCheckpointEpoch?: unknown }).lastCheckpointEpoch === 'number'
      ? (parsed as { lastCheckpointEpoch: number }).lastCheckpointEpoch
      : 0;
  } catch {
    return 0;
  }
};

const epochFromKey = (prefix: string, journalKey: string): number => Number(journalKey.slice(`${prefix}journal:`.length));

/** Read one WAL record under the shared corruption policy: checkpointed corruption is dropped, while newer corruption is recorded as unavoidable loss. */
export const readJournalRecord = (storage: StoragePlane, prefix: string, journalKey: string): JournalRecord | null => {
  const raw = storage.get(journalKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JournalRecord;
  } catch {
    const epoch = epochFromKey(prefix, journalKey);
    const lastCheckpointEpoch = checkpointEpoch(storage, prefix);
    storage.set([{ key: journalKey, value: null }]);
    if (epoch <= lastCheckpointEpoch) {
      noteCorruptionJournalDrop();
      return null;
    }
    noteCorruptionJournalLoss();
    getDbLogger().error('unrecoverable WAL corruption', { key: journalKey, epoch, lastCheckpointEpoch });
    return null;
  }
};

export const createJournal = (storage: StoragePlane, prefix: () => string) => {
  const key = (name: string) => `${prefix()}${name}`;
  const recordKey = (epoch: number) => key(`journal:${epoch}`);

  const allRecords = (): JournalRecord[] =>
    storage
      .keys(key('journal:'))
      .map(journalKey => readJournalRecord(storage, prefix(), journalKey))
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
