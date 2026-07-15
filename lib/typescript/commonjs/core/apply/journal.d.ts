import type { ScopeIndexValue } from '../planes/scopeIndex';
import type { StoragePlane } from '../planes/storagePlane';
export type JournalOp = {
    kind: 'upsert';
    model: string;
    rows: unknown[];
    origin?: 'event' | 'replace';
} | {
    kind: 'patch';
    model: string;
    id: string;
    patch: Record<string, unknown>;
} | {
    kind: 'destroy';
    model: string;
    ids: string[];
    tombstone?: boolean;
} | {
    kind: 'scope';
    model: string;
    scopeKey: string;
    next: ScopeIndexValue;
} | {
    kind: 'scope-delta';
    model: string;
    scopeKey: string;
    append: Array<{
        id: string;
        edge?: Record<string, unknown>;
    }>;
    detach: string[];
} | {
    kind: 'counter';
    model: string;
    id: string;
    field: string;
    delta: number;
};
export type JournalRecord = {
    epoch: number;
    status: 'pending' | 'committed';
    ops: JournalOp[];
};
export declare const createJournal: (storage: StoragePlane, prefix: () => string) => {
    writePending: (record: JournalRecord) => void;
    /** Storage entries marking the record committed + pruning old committed records past the cap. */
    committedEntry: (record: JournalRecord, pruneBeforeEpoch?: number) => Array<{
        key: string;
        value: string | null;
    }>;
    /** Prune committed records after their checkpoint batch has completed successfully. */
    pruneCommitted: (pruneBeforeEpoch: number) => Array<{
        key: string;
        value: string | null;
    }>;
    allRecords: () => JournalRecord[];
    pending: () => JournalRecord[];
    lastEpoch: () => number;
};
//# sourceMappingURL=journal.d.ts.map