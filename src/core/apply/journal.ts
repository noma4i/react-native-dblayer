import { sortBy } from 'es-toolkit';
import type { ScopeIndexValue } from '../planes/scopeIndex';
import type { StoragePlane } from '../planes/storagePlane';
import { noteCorruptionJournalDrop, noteCorruptionJournalLoss, noteDataLoss } from '../diagnostics';
import { getDbLogger } from '../logger';

export type JournalOp =
  | { kind: 'upsert'; model: string; rows: unknown[]; origin?: 'event'; operationId?: string; mergeBase?: never }
  /** Replace carries the normalized prior row through WAL replay so write groups observe the same commit semantics after restart. */
  | { kind: 'upsert'; model: string; rows: unknown[]; origin: 'replace'; mergeBase?: unknown; operationId?: string }
  /** `operationId` lets a pending optimistic method-patch apply its own rollback while foreign patches keep its owned fields. */
  | { kind: 'patch'; model: string; id: string; patch: Record<string, unknown>; operationId?: string }
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

const VALID_JOURNAL_OP_KINDS = new Set(['upsert', 'patch', 'destroy', 'scope', 'scope-delta', 'counter']);

const isValidJournalOp = (value: unknown): value is JournalOp => {
  if (typeof value !== 'object' || value === null) return false;
  const op = value as { kind?: unknown; model?: unknown };
  return typeof op.kind === 'string' && VALID_JOURNAL_OP_KINDS.has(op.kind) && typeof op.model === 'string';
};

/** Shape guard for a parsed-but-possibly-malformed record: valid JSON of the wrong shape (`ops` not an array, a stray op without `kind`/`model`, a non-numeric `epoch`) must route through the same corruption policy as a parse failure, not throw past it during replay. */
const isValidJournalRecord = (value: unknown): value is JournalRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { epoch?: unknown; status?: unknown; ops?: unknown };
  return typeof record.epoch === 'number' && (record.status === 'pending' || record.status === 'committed') && Array.isArray(record.ops) && record.ops.every(isValidJournalOp);
};

/** Read one WAL record under the shared corruption policy: checkpointed corruption is dropped, while newer corruption is recorded as unavoidable loss. Covers both unparseable JSON and parseable JSON of the wrong record shape. */
export const readJournalRecord = (storage: StoragePlane, prefix: string, journalKey: string): JournalRecord | null => {
  const raw = storage.get(journalKey);
  if (!raw) return null;
  const dropAsCorrupt = (): null => {
    const epoch = epochFromKey(prefix, journalKey);
    const lastCheckpointEpoch = checkpointEpoch(storage, prefix);
    storage.set([{ key: journalKey, value: null }]);
    if (epoch <= lastCheckpointEpoch) {
      noteCorruptionJournalDrop();
      noteDataLoss('journal-corruption-checkpointed-drop', '__runtime__', 1);
      return null;
    }
    noteCorruptionJournalLoss();
    noteDataLoss('journal-corruption-loss', '__runtime__', 1);
    getDbLogger().error('unrecoverable WAL corruption', { key: journalKey, epoch, lastCheckpointEpoch });
    return null;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return dropAsCorrupt();
  }
  return isValidJournalRecord(parsed) ? parsed : dropAsCorrupt();
};

export const createJournal = (storage: StoragePlane, prefix: () => string) => {
  const key = (name: string) => `${prefix()}${name}`;
  const recordKey = (epoch: number) => key(`journal:${epoch}`);

  const allRecords = (): JournalRecord[] =>
    sortBy(
      storage
        .keys(key('journal:'))
        .map(journalKey => readJournalRecord(storage, prefix(), journalKey))
        .filter((record): record is JournalRecord => record !== null),
      [record => record.epoch]
    );

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
