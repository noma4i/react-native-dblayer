import type { Journal, JournalRecord, StoragePlane } from '../../types';
export declare const readCheckpointEpoch: (storage: StoragePlane, prefix: string) => number;
/** Read one immutable WAL record and localize corruption after checkpoint coverage. */
export declare const readJournalRecord: (storage: StoragePlane, prefix: string, journalKey: string) => JournalRecord | null;
export declare const createJournal: (storage: StoragePlane, prefix: () => string) => Journal;
//# sourceMappingURL=journal.d.ts.map