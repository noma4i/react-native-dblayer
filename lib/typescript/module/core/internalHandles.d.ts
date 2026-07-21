import type { JournalOp } from './apply/journal';
import type { RelationDecl } from './relations';
import type { ScopeCoverage } from './planes/scopeIndex';
type InternalModelHandle = {
    readRow(id: string): {
        id: string;
        [key: string]: unknown;
    } | undefined;
    applyRows(rows: unknown[]): void;
    planRows(rows: unknown[], options?: {
        includeMembership?: boolean;
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
};
type InternalScopeHandle = {
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
    readRows(scopeValue: unknown): Array<{
        id: string;
        [key: string]: unknown;
    }>;
    isResolved(scopeValue: unknown): boolean;
    noteAccess(scopeValue: unknown): void;
};
export declare const registerInternalModelHandle: (model: object, handle: InternalModelHandle) => void;
export declare const registerInternalScopeHandle: (scope: object, handle: InternalScopeHandle) => void;
export declare const getInternalModelHandle: (model: object) => InternalModelHandle;
export declare const getInternalScopeHandle: (scope: object) => InternalScopeHandle;
export declare const hasInternalScopeHandle: (scope: object) => boolean;
export {};
//# sourceMappingURL=internalHandles.d.ts.map