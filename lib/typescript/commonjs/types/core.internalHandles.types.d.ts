import type { JournalOp } from './core.apply.journal.types';
import type { RelationDecl } from './core.relations.types';
import type { ScopeCoverage } from './core.planes.scopeIndex.types';
import type { RowRecord } from './db.types';
/** Opaque per-model capabilities exposed to query/mutation seams without widening the public model type. */
export type InternalModelHandle = {
    readRow(id: string): RowRecord | undefined;
    applyRows(rows: unknown[]): void;
    applyPatch(id: string, patch: Record<string, unknown>, operationId?: string): void;
    planRows(rows: unknown[], options?: {
        origin?: 'event';
    }): JournalOp[];
    planReplace(oldId: string, next: unknown): JournalOp[];
    captureMembership(id: string): Array<{
        id: string;
        scopeKey: string;
        order: number;
        edge?: Record<string, unknown>;
    }>;
    planRestore(next: unknown, memberships: Array<{
        id: string;
        scopeKey: string;
        order: number;
        edge?: Record<string, unknown>;
    }>): JournalOp[];
    relations(): Record<string, RelationDecl>;
    revision(): number;
    dropTempRowsAfterMs(): number | undefined;
};
/** Opaque per-scope capabilities: apply plans, keying, order semantics, and resolution. */
export type InternalScopeHandle = {
    apply(scopeValue: unknown, rows: unknown[], coverage: ScopeCoverage, options?: {
        resetOrder?: boolean;
    }): void;
    planApply(scopeValue: unknown, rows: Array<{
        row: unknown;
        edge?: Record<string, unknown>;
    }>, coverage: ScopeCoverage, options?: {
        resetOrder?: boolean;
    }): JournalOp[];
    key(scopeValue: unknown): string;
    isServerOrder(): boolean;
    planPlacement(scopeValue: unknown, id: string, position: 'prepend' | 'append'): JournalOp[];
    readRows(scopeValue: unknown): RowRecord[];
    isResolved(scopeValue: unknown): boolean;
    noteAccess(scopeValue: unknown): void;
};
//# sourceMappingURL=core.internalHandles.types.d.ts.map