import type { ScopeIndexValue } from './core.planes.scopeIndex.types';
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
}
/** `replace` marks the destroy half of an identity swap, so relation effects preserve logical existence. */
 | {
    kind: 'destroy';
    model: string;
    ids: string[];
    tombstone?: boolean;
    origin?: 'replace';
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
export type Journal = {
    pendingEntry(record: JournalRecord): Array<{
        key: string;
        value: string | null;
    }>;
    committedEntry(record: JournalRecord, pruneBeforeEpoch?: number): Array<{
        key: string;
        value: string | null;
    }>;
    pruneCommitted(pruneBeforeEpoch: number): Array<{
        key: string;
        value: string | null;
    }>;
    allRecords(): JournalRecord[];
    pending(): JournalRecord[];
    lastEpoch(): number;
};
//# sourceMappingURL=core.apply.journal.types.d.ts.map