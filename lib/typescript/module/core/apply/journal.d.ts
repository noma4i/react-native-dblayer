import type { ScopeIndexValue } from '../planes/scopeIndex';
import type { StoragePlane } from '../planes/storagePlane';
export type JournalOp = {
    kind: 'upsert';
    model: string;
    rows: unknown[];
    origin?: 'event';
    operationId?: string;
    mergeBase?: never;
}
/** Replace carries the normalized prior row through WAL replay so write groups observe the same commit semantics after restart. */
 | {
    kind: 'upsert';
    model: string;
    rows: unknown[];
    origin: 'replace';
    mergeBase?: unknown;
    operationId?: string;
}
/** `operationId` lets a pending optimistic method-patch apply its own rollback while foreign patches keep its owned fields. */
 | {
    kind: 'patch';
    model: string;
    id: string;
    patch: Record<string, unknown>;
    operationId?: string;
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
        order?: number;
    }>;
    detach: string[];
} | {
    kind: 'counter';
    model: string;
    id: string;
    field: string;
    delta: number;
    next?: number;
};
export type JournalRecord = {
    epoch: number;
    status: 'pending' | 'committed';
    ops: JournalOp[];
};
/** Read one WAL record under the shared corruption policy: checkpointed corruption is dropped, while newer corruption is recorded as unavoidable loss. Covers both unparseable JSON and parseable JSON of the wrong record shape. */
export declare const readJournalRecord: (storage: StoragePlane, prefix: string, journalKey: string) => JournalRecord | null;
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