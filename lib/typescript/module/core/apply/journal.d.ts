import type { StoragePlane, Journal, JournalRecord } from '../../types';
/** Read one WAL record under the shared corruption policy: checkpointed corruption is dropped, while newer corruption is recorded as unavoidable loss. Covers both unparseable JSON and parseable JSON of the wrong record shape. */
export declare const readJournalRecord: (storage: StoragePlane, prefix: string, journalKey: string) => JournalRecord | null;
export declare const createJournal: (storage: StoragePlane, prefix: () => string) => Journal;
//# sourceMappingURL=journal.d.ts.map